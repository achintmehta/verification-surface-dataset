/**
 * Hold and confirmation routes.
 *
 * POST /api/holds                  – atomically acquire seats and create a hold
 * POST /api/holds/:holdId/confirm  – confirm (book) a hold idempotently
 * DELETE /api/holds/:holdId        – release a hold early
 */

import { Router } from 'express';
import { getDb, generateId, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/** Build a comma-separated list of $N placeholders starting at `offset` (1-based). */
function placeholders(count, offset = 1) {
  return Array.from({ length: count }, (_, i) => `$${i + offset}`).join(', ');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats.  If any seat is unavailable the
 * entire request fails with 409 and no seats are modified.
 * ───────────────────────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate seat IDs to prevent a single request from double-counting.
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    const db = await getDb();

    // Use an explicit transaction so the check-and-set is atomic.
    const result = await db.transaction(async (tx) => {
      // 1. Release any expired holds first so we have an accurate picture.
      const released = await releaseExpiredHolds(tx);

      // 2. Lock and read the requested seats FOR UPDATE to prevent concurrent
      //    modifications.
      const seatPlaceholders = placeholders(uniqueSeatIds.length, 1);
      const { rows: seats } = await tx.query(
        `SELECT id, status
         FROM   seats
         WHERE  id IN (${seatPlaceholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      // 3. Verify all requested seats actually exist.
      if (seats.length !== uniqueSeatIds.length) {
        const foundIds = new Set(seats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        throw { status: 404, error: 'Unknown seat ids', seatIds: missing };
      }

      // 4. Check availability – every seat must be 'available'.
      const unavailable = seats.filter((s) => s.status !== 'available');
      if (unavailable.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are unavailable',
          conflictingSeatIds: unavailable.map((s) => s.id),
        };
      }

      // 5. Create the hold record.
      const holdId = generateId();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, seat_ids)
         VALUES ($1, $2, $3::timestamptz, $4)`,
        [holdId, sessionId, expiresAt, uniqueSeatIds]
      );

      // 6. Mark every requested seat as held.
      //    Parameters: $1 = holdId, $2 = expiresAt, $3...$N = seatIds
      const updateSeatPlaceholders = placeholders(uniqueSeatIds.length, 3);
      await tx.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = $2::timestamptz
         WHERE  id IN (${updateSeatPlaceholders})`,
        [holdId, expiresAt, ...uniqueSeatIds]
      );

      return { holdId, expiresAt, released };
    });

    // Broadcast any seats that were released during expiry cleanup.
    if (result.released.length > 0) {
      broadcast('released', result.released);
    }

    // Broadcast the newly held seats.
    broadcast(
      'held',
      uniqueSeatIds.map((id) => ({
        id,
        status: 'held',
        holdId: result.holdId,
        holdExpiresAt: result.expiresAt,
        bookedBy: null,
      }))
    );

    return res.status(201).json({
      holdId: result.holdId,
      seatIds: uniqueSeatIds,
      sessionId,
      expiresAt: result.expiresAt,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.error,
        ...(err.conflictingSeatIds && { conflictingSeatIds: err.conflictingSeatIds }),
        ...(err.seatIds && { seatIds: err.seatIds }),
      });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/holds/:holdId/confirm
 *
 * Idempotent: confirming an already-confirmed hold returns the same booking
 * without double-booking.  Expired or unknown holds are rejected.
 * ───────────────────────────────────────────────────────────────────────────── */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // 1. Release expired holds (but NOT this one yet – we need to check it).
      const released = await releaseExpiredHolds(tx);

      // 2. Fetch the hold record with a row lock.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id AS "sessionId", expires_at AS "expiresAt", confirmed, seat_ids AS "seatIds"
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found or already expired' };
      }

      const hold = holdRows[0];

      // 3. Ownership check.
      if (hold.sessionId !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      // 4. Expiry check.
      if (new Date(hold.expiresAt) < new Date()) {
        throw { status: 410, error: 'Hold has expired' };
      }

      // 5. Idempotency: if already confirmed, return the existing booking.
      if (hold.confirmed) {
        // seat_ids are stored on the hold record; look them up directly.
        const confirmedSeatIds = hold.seatIds ?? [];
        return { alreadyConfirmed: true, seatIds: confirmedSeatIds, released };
      }

      // 6. Fetch the seats owned by this hold (with row lock).
      const { rows: heldSeats } = await tx.query(
        `SELECT id
         FROM   seats
         WHERE  hold_id = $1
           AND  status  = 'held'
         FOR UPDATE`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        throw { status: 409, error: 'No held seats found for this hold' };
      }

      const seatIds = heldSeats.map((s) => s.id);

      // 7. Book the seats.
      //    Parameters: $1 = sessionId, $2...$N = seatIds
      const bookPlaceholders = placeholders(seatIds.length, 2);
      await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                booked_by       = $1,
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  id IN (${bookPlaceholders})`,
        [sessionId, ...seatIds]
      );

      // 8. Mark the hold as confirmed (keep the record for idempotency).
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return { alreadyConfirmed: false, seatIds, released };
    });

    // Broadcast any seats released during expiry cleanup.
    if (result.released.length > 0) {
      broadcast('released', result.released);
    }

    if (result.alreadyConfirmed) {
      // Already confirmed – return the existing booking without re-broadcasting.
      return res.json({
        holdId,
        sessionId,
        seatIds: result.seatIds,
        alreadyConfirmed: true,
      });
    }

    // Broadcast the newly booked seats.
    broadcast(
      'booked',
      result.seatIds.map((id) => ({
        id,
        status: 'booked',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: sessionId,
      }))
    );

    return res.json({
      holdId,
      sessionId,
      seatIds: result.seatIds,
      alreadyConfirmed: false,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETE /api/holds/:holdId
 *
 * Release a hold early, returning its seats to 'available'.
 * ───────────────────────────────────────────────────────────────────────────── */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Fetch the hold.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id AS "sessionId", confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      if (hold.sessionId !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release an already-confirmed hold' };
      }

      // Find the seats owned by this hold.
      const { rows: heldSeats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      const seatIds = heldSeats.map((s) => s.id);

      if (seatIds.length > 0) {
        const releasePlaceholders = placeholders(seatIds.length, 1);
        await tx.query(
          `UPDATE seats
           SET    status          = 'available',
                  hold_id         = NULL,
                  hold_expires_at = NULL
           WHERE  id IN (${releasePlaceholders})`,
          seatIds
        );
      }

      // Delete the hold record.
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return { seatIds };
    });

    // Broadcast the released seats.
    if (result.seatIds.length > 0) {
      broadcast(
        'released',
        result.seatIds.map((id) => ({
          id,
          status: 'available',
          holdId: null,
          holdExpiresAt: null,
          bookedBy: null,
        }))
      );
    }

    return res.json({ holdId, releasedSeatIds: result.seatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
