/**
 * Hold routes:
 *
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 *
 * Concurrency guarantee
 * ─────────────────────
 * Every mutating operation runs inside withLock() which serialises all DB
 * work through a single promise-chain queue.  Because PGLite is a single
 * embedded Postgres instance with no network round-trips, this gives us
 * the same safety as a SELECT … FOR UPDATE without needing advisory locks.
 *
 * All-or-nothing hold acquisition
 * ────────────────────────────────
 * We first SELECT the requested seats inside the lock.  If any seat is not
 * 'available' we immediately return 409 with the conflicting seat ids and
 * touch nothing.  Only when every seat is free do we UPDATE them all in a
 * single statement.
 *
 * Idempotent confirmation
 * ───────────────────────
 * If the hold row already has confirmed_at set we return the same success
 * response without touching the seats again.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, withLock, HOLD_TTL_SECONDS } from '../db.js';
import { expireStaleHoldsUnsafe } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a $1, $2, … $N placeholder string for N items. */
function placeholders(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => `$${i + 1 + offset}`).join(', ');
}

// ---------------------------------------------------------------------------
// POST /api/holds
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate seat ids.
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    const db = await getDb();

    const result = await withLock(async () => {
      // 1. Expire stale holds so we have an accurate picture.
      const released = await expireStaleHoldsUnsafe(db);
      if (released.length > 0) broadcast(released);

      // 2. Fetch the requested seats.
      const { rows: seatRows } = await db.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders(uniqueSeatIds.length)})`,
        uniqueSeatIds,
      );

      // 3. Check that all requested seat ids actually exist.
      if (seatRows.length !== uniqueSeatIds.length) {
        const found = new Set(seatRows.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !found.has(id));
        return { status: 400, body: { error: 'Unknown seat ids', missing } };
      }

      // 4. Check availability – every seat must be 'available'.
      const unavailableSeats = seatRows.filter((s) => s.status !== 'available');
      if (unavailableSeats.length > 0) {
        return {
          status: 409,
          body: {
            error: 'One or more seats are unavailable',
            conflictingSeatIds: unavailableSeats.map((s) => s.id),
          },
        };
      }

      // 5. All seats are available – create the hold and mark seats held.
      const holdId = uuidv4();
      const ttlInterval = `${HOLD_TTL_SECONDS} seconds`;

      // Insert hold record.
      await db.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, NOW() + $3::interval)`,
        [holdId, sessionId, ttlInterval],
      );

      // Mark seats as held (single atomic UPDATE).
      // Parameters: $1=holdId, $2=ttlInterval, $3...$N=seatIds
      await db.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = NOW() + $2::interval
         WHERE  id IN (${placeholders(uniqueSeatIds.length, 2)})
           AND  status = 'available'`,
        [holdId, ttlInterval, ...uniqueSeatIds],
      );

      // 6. Verify that we actually updated all seats (race-condition guard).
      //    Because we're inside the mutex this should always match, but we
      //    double-check for safety.
      const { rows: updatedSeats } = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM   seats
         WHERE  id IN (${placeholders(uniqueSeatIds.length)})`,
        uniqueSeatIds,
      );

      const heldCount = updatedSeats.filter(
        (s) => s.status === 'held' && s.hold_id === holdId,
      ).length;

      if (heldCount !== uniqueSeatIds.length) {
        // Something went wrong – roll back by releasing the hold.
        await db.query(
          `UPDATE seats
           SET    status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE  hold_id = $1`,
          [holdId],
        );
        await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);
        return {
          status: 409,
          body: { error: 'Concurrent modification detected; please retry' },
        };
      }

      // 7. Fetch the hold record to return to the client.
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, created_at, expires_at FROM holds WHERE id = $1`,
        [holdId],
      );

      return {
        status: 201,
        body: { hold: holdRows[0], seats: updatedSeats },
        broadcastSeats: updatedSeats,
      };
    });

    if (result.broadcastSeats) {
      broadcast(result.broadcastSeats);
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// ---------------------------------------------------------------------------
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    const result = await withLock(async () => {
      // 1. Expire stale holds.
      const released = await expireStaleHoldsUnsafe(db);
      if (released.length > 0) broadcast(released);

      // 2. Fetch the hold.
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at, confirmed_at, released_at
         FROM   holds
         WHERE  id = $1`,
        [holdId],
      );

      if (holdRows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdRows[0];

      // 3. Ownership check.
      if (hold.session_id !== sessionId) {
        return { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      // 4. Idempotency: already confirmed → return success with booked seats.
      if (hold.confirmed_at) {
        const { rows: bookedSeats } = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId],
        );
        return {
          status: 200,
          body: { message: 'Already confirmed', hold, seats: bookedSeats },
        };
      }

      // 5. Released check.
      if (hold.released_at) {
        return { status: 409, body: { error: 'Hold has already been released' } };
      }

      // 6. Expiry check (belt-and-suspenders; expireStaleHoldsUnsafe above
      //    should have already released it, but we check the hold record too).
      const { rows: nowRows } = await db.query(`SELECT NOW() AS now`);
      const now = new Date(nowRows[0].now);
      const expiresAt = new Date(hold.expires_at);
      if (now > expiresAt) {
        return { status: 409, body: { error: 'Hold has expired' } };
      }

      // 7. Verify seats still belong to this hold.
      const { rows: heldSeats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId],
      );

      if (heldSeats.length === 0) {
        return { status: 409, body: { error: 'No seats found for this hold' } };
      }

      // 8. Book the seats atomically.
      await db.query(
        `UPDATE seats
         SET    status          = 'booked',
                booked_by       = $1,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'`,
        [holdId],
      );

      // 9. Mark hold as confirmed.
      await db.query(
        `UPDATE holds SET confirmed_at = NOW() WHERE id = $1`,
        [holdId],
      );

      // 10. Fetch updated seats and hold.
      const { rows: bookedSeats } = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM   seats
         WHERE  booked_by = $1`,
        [holdId],
      );

      const { rows: updatedHold } = await db.query(
        `SELECT id, session_id, created_at, expires_at, confirmed_at FROM holds WHERE id = $1`,
        [holdId],
      );

      return {
        status: 200,
        body: { hold: updatedHold[0], seats: bookedSeats },
        broadcastSeats: bookedSeats,
      };
    });

    if (result.broadcastSeats) {
      broadcast(result.broadcastSeats);
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// ---------------------------------------------------------------------------
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    const result = await withLock(async () => {
      // 1. Fetch the hold.
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, confirmed_at, released_at FROM holds WHERE id = $1`,
        [holdId],
      );

      if (holdRows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        return { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      if (hold.confirmed_at) {
        return { status: 409, body: { error: 'Cannot release a confirmed hold' } };
      }

      if (hold.released_at) {
        // Idempotent: already released is fine.
        return { status: 200, body: { message: 'Hold already released' } };
      }

      // 2. Release the seats.
      const { rows: releasedSeats } = await db.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId],
      );

      // 3. Mark hold as released.
      await db.query(
        `UPDATE holds SET released_at = NOW() WHERE id = $1`,
        [holdId],
      );

      return {
        status: 200,
        body: { message: 'Hold released', seats: releasedSeats },
        broadcastSeats: releasedSeats,
      };
    });

    if (result.broadcastSeats) {
      broadcast(result.broadcastSeats);
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
