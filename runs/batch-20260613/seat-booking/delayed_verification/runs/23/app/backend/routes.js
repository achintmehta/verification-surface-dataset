const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { addClient, broadcast } = require('./sse');
const { expireStaleHolds } = require('./expiry');

const router = express.Router();

const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '30', 10); // configurable hold TTL

// Inject db into routes
let db;
function setDb(database) {
  db = database;
}

// Helper: parse seat_ids from DB (stored as JSON text)
function parseSeatIds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

// ──────────────────────────────────────────────
// GET /api/seats - Return all seats with effective status
// ──────────────────────────────────────────────
router.get('/seats', async (req, res) => {
  try {
    // First, expire stale holds
    await expireStaleHolds(db);

    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Map effective status: expired holds show as available
    const seats = result.rows.map(seat => {
      if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
        return {
          ...seat,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null
        };
      }
      return seat;
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────
// POST /api/holds - Atomically hold seats
// ──────────────────────────────────────────────
router.post('/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    // Deduplicate seat IDs
    const uniqueSeatIds = [...new Set(seatIds.map(Number))];

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    // Expire stale holds first
    await expireStaleHolds(db);

    // Use a transaction to atomically check and acquire
    const result = await db.transaction(async (tx) => {
      // Lock and fetch the requested seats
      // ORDER BY id for consistent lock ordering
      const seatPlaceholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const fetchResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${seatPlaceholders})
         ORDER BY id
         FOR UPDATE`,
        uniqueSeatIds
      );

      if (fetchResult.rows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(fetchResult.rows.map(r => r.id));
        const missingIds = uniqueSeatIds.filter(id => !foundIds.has(id));
        return { error: 'Some seat IDs not found', missingIds, status: 400 };
      }

      // Check each seat's effective status
      const conflicting = [];
      const expiredInTransaction = [];

      for (const seat of fetchResult.rows) {
        let effectiveStatus = seat.status;
        // If held but expired, treat as available
        if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
          effectiveStatus = 'available';
          expiredInTransaction.push(seat.id);
        }
        if (effectiveStatus !== 'available') {
          conflicting.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: effectiveStatus
          });
        }
      }

      // Release any expired holds found inline
      if (expiredInTransaction.length > 0) {
        const expPlaceholders = expiredInTransaction.map((_, i) => `$${i + 1}`).join(', ');
        await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id IN (${expPlaceholders})`,
          expiredInTransaction
        );
        await tx.query(
          `UPDATE holds SET status = 'expired'
           WHERE status = 'active' AND expires_at <= NOW()`
        );
      }

      // If any seat is unavailable, fail the entire request (all-or-nothing)
      if (conflicting.length > 0) {
        return { error: 'Some seats are unavailable', conflicting, status: 409 };
      }

      // All seats are available - acquire them all
      const updatePlaceholders = uniqueSeatIds.map((_, i) => `$${i + 4}`).join(', ');
      await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_expires_at = $2,
             session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt.toISOString(), sessionId, ...uniqueSeatIds]
      );

      // Insert hold record (seat_ids as JSON text)
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, JSON.stringify(uniqueSeatIds), expiresAt.toISOString()]
      );

      return { success: true };
    });

    if (result.error) {
      return res.status(result.status).json({
        error: result.error,
        conflicting: result.conflicting,
        missingIds: result.missingIds
      });
    }

    // Fetch the updated seats for the response and broadcast
    const seatPlaceholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
    const updatedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
       FROM seats WHERE id IN (${seatPlaceholders})`,
      uniqueSeatIds
    );

    // Broadcast seat updates
    broadcast('seatUpdate', updatedSeats.rows);

    res.status(201).json({
      holdId,
      expiresAt: expiresAt.toISOString(),
      seats: updatedSeats.rows
    });
  } catch (err) {
    console.error('POST /api/holds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────
// POST /api/holds/:holdId/confirm - Confirm a hold (idempotent)
// ──────────────────────────────────────────────
router.post('/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;

    // Expire stale holds first
    await expireStaleHolds(db);

    const result = await db.transaction(async (tx) => {
      // Fetch the hold record
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: 'Hold not found', status: 404 };
      }

      const hold = holdResult.rows[0];
      const seatIds = parseSeatIds(hold.seat_ids);

      // Idempotent: if already confirmed, return success with the same data
      if (hold.status === 'confirmed') {
        const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
        const seatsResult = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by, session_id
           FROM seats WHERE id IN (${seatPlaceholders})`,
          seatIds
        );
        return {
          success: true,
          idempotent: true,
          confirmedAt: hold.confirmed_at,
          seats: seatsResult.rows
        };
      }

      // Check if expired
      if (hold.status === 'expired' || new Date(hold.expires_at) <= new Date()) {
        // Mark as expired if not already
        if (hold.status !== 'expired') {
          await tx.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1`,
            [holdId]
          );
          // Release seats owned by this hold
          const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
          await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE id IN (${seatPlaceholders}) AND hold_id = $${seatIds.length + 1}`,
            [...seatIds, holdId]
          );
        }
        return { error: 'Hold has expired', status: 410 };
      }

      // Check if released
      if (hold.status === 'released') {
        return { error: 'Hold has been released', status: 410 };
      }

      // Verify the hold is active and seats are still held by this hold
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const seatsResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
         WHERE id IN (${seatPlaceholders})
         FOR UPDATE`,
        seatIds
      );

      // Verify all seats are still held by this hold
      for (const seat of seatsResult.rows) {
        if (seat.status !== 'held' || seat.hold_id !== holdId) {
          return {
            error: 'Hold is no longer valid - seats have been released or taken',
            status: 409
          };
        }
      }

      // All good - confirm: mark seats as booked
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(', ');
      await tx.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_expires_at = NULL,
             session_id = $2
         WHERE id IN (${updatePlaceholders})`,
        [holdId, hold.session_id, ...seatIds]
      );

      // Update hold status
      await tx.query(
        `UPDATE holds
         SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1`,
        [holdId]
      );

      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, booked_by, session_id
         FROM seats WHERE id IN (${seatPlaceholders})`,
        seatIds
      );

      return { success: true, seats: updatedSeats.rows };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast seat updates (skip if idempotent - already broadcast first time)
    if (!result.idempotent) {
      broadcast('seatUpdate', result.seats);
    }

    res.json({
      bookingId: holdId,
      seats: result.seats,
      confirmedAt: result.confirmedAt || new Date().toISOString()
    });
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────
// DELETE /api/holds/:holdId - Release a hold early
// ──────────────────────────────────────────────
router.delete('/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;

    const result = await db.transaction(async (tx) => {
      // Fetch and lock the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: 'Hold not found', status: 404 };
      }

      const hold = holdResult.rows[0];
      const seatIds = parseSeatIds(hold.seat_ids);

      if (hold.status === 'confirmed') {
        return { error: 'Cannot release a confirmed hold', status: 400 };
      }

      if (hold.status === 'released' || hold.status === 'expired') {
        // Already released/expired - idempotent
        return { success: true, alreadyReleased: true };
      }

      // Release the seats
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const releasedSeats = await tx.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_expires_at = NULL,
             session_id = NULL
         WHERE id IN (${seatPlaceholders})
           AND hold_id = $${seatIds.length + 1}
         RETURNING id, row_label, seat_number`,
        [...seatIds, holdId]
      );

      // Update hold status
      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      return { success: true, seats: releasedSeats.rows };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast released seats
    if (result.seats && result.seats.length > 0) {
      const updates = result.seats.map(s => ({
        ...s,
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null
      }));
      broadcast('seatUpdate', updates);
    }

    res.json({ released: true });
  } catch (err) {
    console.error('DELETE /api/holds/:holdId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────
// GET /api/stream - SSE endpoint
// ──────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to seat updates' })}\n\n`);

  // Keep alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  addClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

module.exports = { router, setDb };
