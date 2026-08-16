import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { _expireStaleHoldsUnsafe, expireStaleHolds } from './expiry.js';
import { withLock } from './lock.js';

const router = Router();

const HOLD_TTL_SECONDS = 30; // 30 second hold TTL

// ─── SSE Stream ──────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  // Send a heartbeat immediately
  res.write(': heartbeat\n\n');

  addClient(res);

  // Keep-alive heartbeat every 15 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

// ─── GET /seats ──────────────────────────────────────────────
router.get('/seats', async (req, res) => {
  try {
    // Expire stale holds first (acquires lock itself)
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status,
             hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Map seats with effective status:
    // If held but expired, report as available
    const now = new Date();
    const seats = result.rows.map(seat => {
      let effectiveStatus = seat.status;
      if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= now) {
        effectiveStatus = 'available';
      }
      return {
        id: seat.id,
        rowLabel: seat.row_label,
        seatNumber: seat.seat_number,
        status: effectiveStatus,
        holdId: effectiveStatus === 'held' ? seat.hold_id : null,
        holdExpiresAt: effectiveStatus === 'held' ? seat.hold_expires_at : null,
        sessionId: effectiveStatus === 'available' ? null : seat.session_id,
        bookedBy: seat.booked_by,
      };
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds ─────────────────────────────────────────────
router.post('/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate and validate seatIds are integers
  const uniqueSeatIds = [...new Set(seatIds.map(id => parseInt(id, 10)))];
  if (uniqueSeatIds.some(id => isNaN(id))) {
    return res.status(400).json({ error: 'seatIds must be integers' });
  }

  try {
    const result = await withLock(async () => {
      // Expire stale holds first (we already hold the lock)
      await _expireStaleHoldsUnsafe();

      const db = await getDb();
      const holdId = uuidv4();

      return await db.transaction(async (tx) => {
        // Check all requested seats (ordered to be consistent)
        const seatCheck = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
          FROM seats
          WHERE id = ANY($1)
          ORDER BY id
        `, [uniqueSeatIds]);

        if (seatCheck.rows.length !== uniqueSeatIds.length) {
          const foundIds = seatCheck.rows.map(r => r.id);
          const missingIds = uniqueSeatIds.filter(id => !foundIds.includes(id));
          return { error: true, status: 400, body: { error: 'Some seat IDs not found', missingIds } };
        }

        // Check which seats are unavailable (considering expired holds as available)
        const now = new Date();
        const conflicting = [];
        for (const seat of seatCheck.rows) {
          if (seat.status === 'booked') {
            conflicting.push({ seatId: seat.id, rowLabel: seat.row_label, seatNumber: seat.seat_number, reason: 'booked' });
          } else if (seat.status === 'held') {
            // Check if hold is still active
            if (seat.hold_expires_at && new Date(seat.hold_expires_at) > now) {
              conflicting.push({ seatId: seat.id, rowLabel: seat.row_label, seatNumber: seat.seat_number, reason: 'held' });
            }
            // else: expired hold, treat as available — expiry sweep already ran
          }
        }

        if (conflicting.length > 0) {
          return {
            error: true,
            status: 409,
            body: { error: 'Some seats are unavailable', conflicting }
          };
        }

        // All seats are available (or have expired holds). Acquire them all.
        const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

        // Update seats
        await tx.query(`
          UPDATE seats
          SET status = 'held',
              hold_id = $1,
              hold_expires_at = $2,
              session_id = $3
          WHERE id = ANY($4)
        `, [holdId, expiresAt.toISOString(), sessionId, uniqueSeatIds]);

        // Create the hold record
        await tx.query(`
          INSERT INTO holds (id, session_id, seat_ids, expires_at)
          VALUES ($1, $2, $3, $4)
        `, [holdId, sessionId, uniqueSeatIds, expiresAt.toISOString()]);

        // Return the updated seats for broadcasting
        const updatedSeats = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
          FROM seats
          WHERE id = ANY($1)
        `, [uniqueSeatIds]);

        return {
          error: false,
          holdId,
          expiresAt: expiresAt.toISOString(),
          seats: updatedSeats.rows
        };
      });
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast seat updates
    for (const seat of result.seats) {
      broadcast('seat-update', {
        seatId: seat.id,
        rowLabel: seat.row_label,
        seatNumber: seat.seat_number,
        status: 'held',
        holdId: seat.hold_id,
        holdExpiresAt: seat.hold_expires_at,
        sessionId: seat.session_id
      });
    }

    res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seatIds: uniqueSeatIds
    });
  } catch (err) {
    console.error('POST /holds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds/:holdId/confirm ────────────────────────────
router.post('/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await withLock(async () => {
      // Expire stale holds first (we already hold the lock)
      await _expireStaleHoldsUnsafe();

      const db = await getDb();

      return await db.transaction(async (tx) => {
        // Get the hold
        const holdResult = await tx.query(`
          SELECT id, session_id, seat_ids, expires_at, status
          FROM holds
          WHERE id = $1
        `, [holdId]);

        if (holdResult.rows.length === 0) {
          return { error: true, status: 404, body: { error: 'Hold not found' } };
        }

        const hold = holdResult.rows[0];

        // Idempotency: if already confirmed, return success
        if (hold.status === 'confirmed') {
          const bookedSeats = await tx.query(`
            SELECT id, row_label, seat_number, status, booked_by, session_id
            FROM seats
            WHERE id = ANY($1)
            ORDER BY id
          `, [hold.seat_ids]);

          return {
            error: false,
            alreadyConfirmed: true,
            holdId: hold.id,
            sessionId: hold.session_id,
            seats: bookedSeats.rows
          };
        }

        // Check if hold is expired
        if (hold.status === 'expired' || new Date(hold.expires_at) <= new Date()) {
          // Also mark it as expired in DB if not already
          if (hold.status !== 'expired') {
            await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
            // Release seats that are still held by this hold
            await tx.query(`
              UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
              WHERE hold_id = $1 AND status = 'held'
            `, [holdId]);
          }
          return { error: true, status: 410, body: { error: 'Hold has expired' } };
        }

        if (hold.status === 'released') {
          return { error: true, status: 410, body: { error: 'Hold was released' } };
        }

        // Verify all seats are still held by this hold
        const seatResult = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id
          FROM seats
          WHERE id = ANY($1)
          ORDER BY id
        `, [hold.seat_ids]);

        const invalidSeats = seatResult.rows.filter(s => s.status !== 'held' || s.hold_id !== holdId);
        if (invalidSeats.length > 0) {
          return {
            error: true,
            status: 409,
            body: { error: 'Hold seats are no longer valid', invalidSeats: invalidSeats.map(s => s.id) }
          };
        }

        // Book all the seats
        await tx.query(`
          UPDATE seats
          SET status = 'booked',
              booked_by = $1,
              hold_id = NULL,
              hold_expires_at = NULL
          WHERE id = ANY($2) AND hold_id = $3
        `, [hold.session_id, hold.seat_ids, holdId]);

        // Mark hold as confirmed
        await tx.query(`
          UPDATE holds SET status = 'confirmed' WHERE id = $1
        `, [holdId]);

        const bookedSeats = await tx.query(`
          SELECT id, row_label, seat_number, status, booked_by, session_id
          FROM seats
          WHERE id = ANY($1)
          ORDER BY id
        `, [hold.seat_ids]);

        return {
          error: false,
          alreadyConfirmed: false,
          holdId: hold.id,
          sessionId: hold.session_id,
          seats: bookedSeats.rows
        };
      });
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast seat updates (only if this wasn't already confirmed)
    if (!result.alreadyConfirmed) {
      for (const seat of result.seats) {
        broadcast('seat-update', {
          seatId: seat.id,
          rowLabel: seat.row_label,
          seatNumber: seat.seat_number,
          status: 'booked',
          holdId: null,
          sessionId: seat.session_id,
          bookedBy: seat.booked_by
        });
      }
    }

    res.json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.seats.map(s => s.id),
      status: 'confirmed'
    });
  } catch (err) {
    console.error('POST /holds/:holdId/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /holds/:holdId ───────────────────────────────────
router.delete('/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await withLock(async () => {
      const db = await getDb();

      return await db.transaction(async (tx) => {
        const holdResult = await tx.query(`
          SELECT id, session_id, seat_ids, status
          FROM holds
          WHERE id = $1
        `, [holdId]);

        if (holdResult.rows.length === 0) {
          return { error: true, status: 404, body: { error: 'Hold not found' } };
        }

        const hold = holdResult.rows[0];

        if (hold.status === 'confirmed') {
          return { error: true, status: 400, body: { error: 'Cannot release a confirmed hold' } };
        }

        if (hold.status === 'released' || hold.status === 'expired') {
          // Already released, idempotent
          return { error: false, alreadyReleased: true, holdId: hold.id };
        }

        // Release the seats
        const releasedSeats = await tx.query(`
          UPDATE seats
          SET status = 'available',
              hold_id = NULL,
              hold_expires_at = NULL,
              session_id = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number
        `, [holdId]);

        // Mark hold as released
        await tx.query(`
          UPDATE holds SET status = 'released' WHERE id = $1
        `, [holdId]);

        return {
          error: false,
          alreadyReleased: false,
          holdId: hold.id,
          seats: releasedSeats.rows
        };
      });
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    // Broadcast releases
    if (!result.alreadyReleased && result.seats) {
      for (const seat of result.seats) {
        broadcast('seat-update', {
          seatId: seat.id,
          rowLabel: seat.row_label,
          seatNumber: seat.seat_number,
          status: 'available',
          holdId: null,
          sessionId: null
        });
      }
    }

    res.json({ holdId: result.holdId, status: 'released' });
  } catch (err) {
    console.error('DELETE /holds/:holdId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
