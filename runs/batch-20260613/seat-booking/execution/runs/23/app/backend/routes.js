const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { addClient, broadcast } = require('./sse');
const { expireStaleHolds } = require('./expiry');

const router = express.Router();

const HOLD_TTL_SECONDS = 30; // 30 second TTL for holds

/**
 * Build a SQL IN-clause placeholder string starting at a given parameter index.
 * e.g. buildInPlaceholders(3, 3) => "$3, $4, $5"
 */
function buildInPlaceholders(startIdx, count) {
  return Array.from({ length: count }, (_, i) => `$${startIdx + i}`).join(', ');
}

// ─── SSE stream ────────────────────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));
  addClient(res);
});

// ─── GET /seats ────────────────────────────────────────────────────────────────
router.get('/seats', async (req, res) => {
  try {
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    const seats = result.rows.map(seat => {
      if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
        return {
          ...seat,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
        };
      }
      return seat;
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds ───────────────────────────────────────────────────────────────
router.post('/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Ensure seatIds are integers
  const parsedSeatIds = seatIds.map(id => parseInt(id, 10));
  if (parsedSeatIds.some(isNaN)) {
    return res.status(400).json({ error: 'All seatIds must be valid integers' });
  }

  try {
    await expireStaleHolds();

    const db = await getDb();
    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    const result = await db.transaction(async (tx) => {
      // Lock and check all requested seats atomically using FOR UPDATE
      const selectPlaceholders = buildInPlaceholders(1, parsedSeatIds.length);
      const lockedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${selectPlaceholders})
         FOR UPDATE`,
        parsedSeatIds
      );

      if (lockedSeats.rows.length !== parsedSeatIds.length) {
        const foundIds = new Set(lockedSeats.rows.map(r => r.id));
        const missing = parsedSeatIds.filter(id => !foundIds.has(id));
        return { error: true, status: 400, body: { error: 'Some seat IDs not found', missingIds: missing } };
      }

      // Check availability; treat expired holds as available
      const conflicting = [];
      const expiredInTx = [];

      for (const seat of lockedSeats.rows) {
        if (seat.status === 'booked') {
          conflicting.push(seat.id);
        } else if (seat.status === 'held') {
          if (seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
            expiredInTx.push(seat);
          } else {
            conflicting.push(seat.id);
          }
        }
      }

      // Release expired holds inline
      for (const seat of expiredInTx) {
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL WHERE id = $1`,
          [seat.id]
        );
        if (seat.hold_id) {
          await tx.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
            [seat.hold_id]
          );
        }
      }

      if (conflicting.length > 0) {
        return { error: true, status: 409, body: { error: 'Some seats are unavailable', conflictingSeatIds: conflicting } };
      }

      // Create the hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3::timestamptz)`,
        [holdId, sessionId, expiresAt]
      );

      // Mark seats as held - build placeholders for seatIds starting at $4
      const updatePlaceholders = buildInPlaceholders(4, parsedSeatIds.length);
      await tx.query(
        `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2::timestamptz, session_id = $3
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, sessionId, ...parsedSeatIds]
      );

      // Fetch updated seats
      const fetchPlaceholders = buildInPlaceholders(1, parsedSeatIds.length);
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE id IN (${fetchPlaceholders})`,
        parsedSeatIds
      );

      return {
        error: false,
        holdId,
        expiresAt,
        seats: updated.rows,
        expiredInTx,
      };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast expired seats that were released inline (if any seats from other holds were freed)
    if (result.expiredInTx && result.expiredInTx.length > 0) {
      // The seats were immediately re-held, so we just broadcast the held state
    }

    // Broadcast newly held seats
    broadcast('seat-update', result.seats.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: s.status,
      hold_id: s.hold_id,
      hold_expires_at: s.hold_expires_at,
      session_id: s.session_id,
      booked_by: s.booked_by,
    })));

    res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seats: result.seats,
    });

  } catch (err) {
    console.error('POST /holds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds/:holdId/confirm ──────────────────────────────────────────────
router.post('/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    await expireStaleHolds();

    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Lock the hold record
      const holdResult = await tx.query(
        `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return the booked seats
      if (hold.status === 'confirmed') {
        const bookedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats WHERE hold_id = $1`,
          [holdId]
        );
        return { error: false, alreadyConfirmed: true, seats: bookedSeats.rows };
      }

      // Reject expired or released holds
      if (hold.status === 'expired' || hold.status === 'released') {
        return { error: true, status: 410, body: { error: `Hold is ${hold.status}` } };
      }

      // Check TTL
      if (new Date(hold.expires_at) <= new Date()) {
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        const releasedSeats = await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [holdId]
        );
        return {
          error: true,
          status: 410,
          body: { error: 'Hold has expired' },
          releasedSeats: releasedSeats.rows,
        };
      }

      // Lock and verify the seats belonging to this hold
      const heldSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, session_id
         FROM seats WHERE hold_id = $1 FOR UPDATE`,
        [holdId]
      );

      const notHeld = heldSeats.rows.filter(s => s.status !== 'held' || s.hold_id !== holdId);
      if (notHeld.length > 0) {
        return { error: true, status: 409, body: { error: 'Some seats are no longer held by this hold' } };
      }

      if (heldSeats.rows.length === 0) {
        return { error: true, status: 410, body: { error: 'Hold has no seats (may have expired)' } };
      }

      // Book the seats
      await tx.query(
        `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2 AND status = 'held'`,
        [hold.session_id, holdId]
      );

      // Mark hold as confirmed
      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      // Fetch the updated seats
      const bookedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      return { error: false, alreadyConfirmed: false, seats: bookedSeats.rows };
    });

    if (result.error) {
      if (result.releasedSeats && result.releasedSeats.length > 0) {
        broadcast('seat-update', result.releasedSeats.map(s => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
          booked_by: null,
        })));
      }
      return res.status(result.status).json(result.body);
    }

    // Broadcast booked seats (only if newly confirmed)
    if (!result.alreadyConfirmed) {
      broadcast('seat-update', result.seats.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
        hold_id: s.hold_id,
        hold_expires_at: s.hold_expires_at,
        session_id: s.session_id,
        booked_by: s.booked_by,
      })));
    }

    res.json({
      holdId,
      status: 'confirmed',
      seats: result.seats,
    });

  } catch (err) {
    console.error('POST /holds/:holdId/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /holds/:holdId ─────────────────────────────────────────────────────
router.delete('/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, status FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: true, status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdResult.rows[0];

      if (hold.status === 'confirmed') {
        return { error: true, status: 400, body: { error: 'Cannot release a confirmed hold' } };
      }

      if (hold.status === 'released' || hold.status === 'expired') {
        return { error: false, seats: [] };
      }

      const releasedSeats = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );

      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      return { error: false, seats: releasedSeats.rows };
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    if (result.seats.length > 0) {
      broadcast('seat-update', result.seats.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null,
      })));
    }

    res.json({ holdId, status: 'released', seats: result.seats });

  } catch (err) {
    console.error('DELETE /holds/:holdId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /inventory ────────────────────────────────────────────────────────────
router.get('/inventory', async (req, res) => {
  try {
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > NOW()) as held,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) as total
      FROM seats
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /inventory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
