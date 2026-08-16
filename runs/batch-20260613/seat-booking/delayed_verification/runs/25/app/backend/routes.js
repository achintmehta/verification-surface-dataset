import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { expireStaleHolds } from './expiry.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '30', 10);

// ─── SSE Stream ───────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  // Send a heartbeat comment every 15s to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });

  addClient(res);
});

// ─── GET /seats ─────────────────────────────────────────────
router.get('/seats', async (_req, res) => {
  try {
    // Expire stale holds first (lazy expiry on read)
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Map effective status: held seats past TTL show as available
    const seats = result.rows.map(seat => {
      let effectiveStatus = seat.status;
      if (
        seat.status === 'held' &&
        seat.hold_expires_at &&
        new Date(seat.hold_expires_at) <= new Date()
      ) {
        effectiveStatus = 'available';
      }
      return {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: effectiveStatus,
        hold_id: effectiveStatus === 'held' ? seat.hold_id : null,
        hold_expires_at: effectiveStatus === 'held' ? seat.hold_expires_at : null,
        session_id: effectiveStatus === 'held' ? seat.session_id : (seat.status === 'booked' ? seat.booked_by : null),
      };
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds ────────────────────────────────────────────
router.post('/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // De-duplicate and validate seat ids are integers
  const uniqueSeatIds = [...new Set(seatIds.map(id => parseInt(id, 10)))];
  if (uniqueSeatIds.some(isNaN)) {
    return res.status(400).json({ error: 'Invalid seat id(s)' });
  }

  try {
    const db = await getDb();

    // Run everything in a transaction for atomicity
    // First, expire stale holds
    await expireStaleHolds();

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // Use a transaction to atomically check and acquire all seats
    // PGLite supports transactions via db.transaction()
    const result = await db.transaction(async (tx) => {
      // Lock and check all requested seats
      // Using FOR UPDATE to lock the rows within the transaction
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const checkResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      if (checkResult.rows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(checkResult.rows.map(r => r.id));
        const missingIds = uniqueSeatIds.filter(id => !foundIds.has(id));
        return { error: 'not_found', missingIds };
      }

      // Check each seat's availability (treating expired holds as available)
      const conflicting = [];
      for (const seat of checkResult.rows) {
        const isExpiredHold =
          seat.status === 'held' &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at) <= new Date();

        if (seat.status === 'booked') {
          conflicting.push({ id: seat.id, row_label: seat.row_label, seat_number: seat.seat_number, status: 'booked' });
        } else if (seat.status === 'held' && !isExpiredHold) {
          conflicting.push({ id: seat.id, row_label: seat.row_label, seat_number: seat.seat_number, status: 'held' });
        }
        // If it's an expired hold, treat as available — we'll release it
      }

      if (conflicting.length > 0) {
        return { error: 'conflict', conflicting };
      }

      // Release any expired holds on these seats (within transaction)
      await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${placeholders})
           AND status = 'held'
           AND hold_expires_at IS NOT NULL
           AND hold_expires_at <= NOW()`,
        uniqueSeatIds
      );

      // Now acquire all seats
      await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $${uniqueSeatIds.length + 1},
             hold_expires_at = $${uniqueSeatIds.length + 2},
             session_id = $${uniqueSeatIds.length + 3}
         WHERE id IN (${placeholders})`,
        [...uniqueSeatIds, holdId, expiresAt, sessionId]
      );

      // Create the hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [holdId, sessionId, uniqueSeatIds, expiresAt]
      );

      // Fetch the updated seats for the response
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
         FROM seats
         WHERE id IN (${placeholders})`,
        uniqueSeatIds
      );

      return { success: true, seats: updatedSeats.rows };
    });

    if (result.error === 'conflict') {
      return res.status(409).json({
        error: 'Some seats are unavailable',
        conflicting: result.conflicting,
      });
    }

    if (result.error === 'not_found') {
      return res.status(404).json({
        error: 'Some seat ids not found',
        missingIds: result.missingIds,
      });
    }

    // Broadcast seat status changes
    const seatUpdates = result.seats.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: 'held',
      hold_id: holdId,
      hold_expires_at: expiresAt,
      session_id: sessionId,
    }));
    broadcast('seats-updated', seatUpdates);

    return res.status(201).json({
      hold: {
        id: holdId,
        sessionId,
        seatIds: uniqueSeatIds,
        expiresAt,
        status: 'active',
      },
      seats: seatUpdates,
    });
  } catch (err) {
    console.error('POST /holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds/:holdId/confirm ────────────────────────────
router.post('/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    // Expire stale holds first
    await expireStaleHolds();

    const result = await db.transaction(async (tx) => {
      // Look up the hold record with a lock
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: 'not_found' };
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return the booking
      if (hold.status === 'confirmed') {
        const bookedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM seats
           WHERE hold_id = $1`,
          [holdId]
        );
        return {
          success: true,
          idempotent: true,
          hold,
          seats: bookedSeats.rows,
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
          // Release the seats
          const seatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
          await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE id IN (${seatPlaceholders}) AND hold_id = $${hold.seat_ids.length + 1}`,
            [...hold.seat_ids, holdId]
          );
        }
        return { error: 'expired' };
      }

      if (hold.status === 'released') {
        return { error: 'released' };
      }

      // Verify the seats are still held by this hold_id
      const seatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
      const seatCheck = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
         WHERE id IN (${seatPlaceholders})
         FOR UPDATE`,
        hold.seat_ids
      );

      // Verify all seats are still held by this hold
      const ownedSeats = seatCheck.rows.filter(s => s.hold_id === holdId && s.status === 'held');
      if (ownedSeats.length !== hold.seat_ids.length) {
        // Some seats are no longer held by this hold — should not happen under normal flow
        // Mark hold as expired
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        return { error: 'seats_lost' };
      }

      // Confirm: mark seats as booked
      await tx.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $${hold.seat_ids.length + 1},
             hold_expires_at = NULL
         WHERE id IN (${seatPlaceholders}) AND hold_id = $${hold.seat_ids.length + 2}`,
        [...hold.seat_ids, hold.session_id, holdId]
      );

      // Mark the hold as confirmed
      await tx.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      // Fetch updated seats
      const updatedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, booked_by
         FROM seats
         WHERE id IN (${seatPlaceholders})`,
        hold.seat_ids
      );

      return {
        success: true,
        idempotent: false,
        hold: { ...hold, status: 'confirmed' },
        seats: updatedSeats.rows,
      };
    });

    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Hold not found' });
    }
    if (result.error === 'expired') {
      return res.status(410).json({ error: 'Hold has expired' });
    }
    if (result.error === 'released') {
      return res.status(410).json({ error: 'Hold was released' });
    }
    if (result.error === 'seats_lost') {
      return res.status(409).json({ error: 'Hold seats are no longer valid' });
    }

    // Broadcast seat status changes (only if not idempotent / first confirm)
    if (!result.idempotent) {
      const seatUpdates = result.seats.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: 'booked',
        hold_id: s.hold_id,
        session_id: result.hold.session_id,
      }));
      broadcast('seats-updated', seatUpdates);
    }

    return res.json({
      booking: {
        holdId: result.hold.id,
        sessionId: result.hold.session_id,
        seatIds: result.hold.seat_ids,
        status: 'confirmed',
      },
      seats: result.seats.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: s.status,
      })),
    });
  } catch (err) {
    console.error('POST /holds/:holdId/confirm error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /holds/:holdId ──────────────────────────────────
router.delete('/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: 'not_found' };
      }

      const hold = holdResult.rows[0];

      if (hold.status === 'confirmed') {
        return { error: 'already_confirmed' };
      }

      if (hold.status === 'released') {
        return { success: true, alreadyReleased: true, seats: [] };
      }

      // Release the seats
      const seatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
      const released = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${seatPlaceholders}) AND hold_id = $${hold.seat_ids.length + 1}
         RETURNING id, row_label, seat_number`,
        [...hold.seat_ids, holdId]
      );

      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      return { success: true, seats: released.rows };
    });

    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Hold not found' });
    }
    if (result.error === 'already_confirmed') {
      return res.status(409).json({ error: 'Hold already confirmed, cannot release' });
    }

    // Broadcast releases
    if (result.seats.length > 0) {
      const seatUpdates = result.seats.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: 'available',
      }));
      broadcast('seats-updated', seatUpdates);
    }

    return res.json({ released: true });
  } catch (err) {
    console.error('DELETE /holds/:holdId error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
