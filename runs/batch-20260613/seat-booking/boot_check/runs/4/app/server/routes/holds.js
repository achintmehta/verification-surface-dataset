import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

/**
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently
 * available. On success, creates a hold record and marks those seats held.
 * If any seat is unavailable, acquires NONE and returns 409 with conflicting
 * seat ids.
 */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    // Run inside a serialisable transaction so the check-and-set is atomic
    const result = await db.transaction(async (tx) => {
      // 1. Expire stale holds first (inside the transaction)
      await expireStaleHoldsInTx(tx);

      // 2. Lock and read the requested seats FOR UPDATE
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      // 3. Verify all requested seat ids exist
      if (seats.length !== seatIds.length) {
        const foundIds = new Set(seats.map((s) => s.id));
        const missing = seatIds.filter((id) => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', seatIds: missing };
      }

      // 4. Check for conflicts (unavailable seats)
      const conflicting = seats.filter((s) => {
        if (s.status === 'booked') return true;
        if (s.status === 'held') {
          // Double-check expiry inline (belt-and-suspenders)
          if (s.hold_expires_at && new Date(s.hold_expires_at) < new Date()) {
            return false; // effectively available
          }
          return true;
        }
        return false;
      });

      if (conflicting.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are unavailable',
          conflictingSeatIds: conflicting.map((s) => s.id),
        };
      }

      // 5. Create the hold record
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(
        `INSERT INTO holds (id, session_id, status, expires_at)
         VALUES ($1, $2, 'active', $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // 6. Mark all requested seats as held
      await tx.query(
        `UPDATE seats
         SET    status = 'held',
                hold_id = $1,
                hold_expires_at = $2
         WHERE  id IN (${placeholders})`,
        [holdId, expiresAt.toISOString(), ...seatIds]
      );

      return { holdId, expiresAt, seatIds };
    });

    // Broadcast the hold to all SSE clients
    broadcast('seats:held', {
      seats: result.seatIds.map((id) => ({ id, status: 'held' })),
      holdId: result.holdId,
      expiresAt: result.expiresAt.toISOString(),
    });

    return res.status(201).json({
      holdId: result.holdId,
      seatIds: result.seatIds,
      sessionId,
      expiresAt: result.expiresAt.toISOString(),
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

/**
 * POST /api/holds/:holdId/confirm
 * Idempotently confirms a hold, booking all its seats permanently.
 * Fails if the hold is expired, unknown, or belongs to a different session.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // 1. Expire stale holds first
      await expireStaleHoldsInTx(tx);

      // 2. Fetch the hold record (lock it)
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, status, expires_at
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      // 3. Ownership check
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      // 4. Idempotency: already confirmed → return existing booking
      if (hold.status === 'confirmed') {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId]
        );
        return { alreadyConfirmed: true, seats: bookedSeats, holdId };
      }

      // 5. Reject expired / released holds
      if (hold.status === 'expired' || hold.status === 'released') {
        throw { status: 409, error: `Hold is ${hold.status} and cannot be confirmed` };
      }

      // 6. Check wall-clock expiry (belt-and-suspenders)
      if (new Date(hold.expires_at) < new Date()) {
        // Mark it expired
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        throw { status: 409, error: 'Hold has expired' };
      }

      // 7. Fetch and lock the seats belonging to this hold
      const { rows: seats } = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (seats.length === 0) {
        throw { status: 409, error: 'No seats found for this hold' };
      }

      // 8. Verify every seat is still held by this hold
      const wrongSeats = seats.filter((s) => s.status !== 'held' || s.hold_id !== holdId);
      if (wrongSeats.length > 0) {
        throw { status: 409, error: 'Some seats are no longer held by this hold' };
      }

      // 9. Book the seats
      await tx.query(
        `UPDATE seats
         SET    status = 'booked',
                hold_id = NULL,
                hold_expires_at = NULL,
                booked_by = $1
         WHERE  hold_id = $2`,
        [holdId, holdId]
      );

      // 10. Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      return { alreadyConfirmed: false, seats, holdId };
    });

    if (!result.alreadyConfirmed) {
      broadcast('seats:booked', {
        seats: result.seats.map((s) => ({ id: s.id, status: 'booked' })),
        holdId: result.holdId,
      });
    }

    return res.json({
      success: true,
      holdId: result.holdId,
      seats: result.seats.map((s) => ({ id: s.id, status: 'booked' })),
      alreadyConfirmed: result.alreadyConfirmed,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/holds/:holdId
 * Releases a hold early, returning its seats to available.
 */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, status FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.status !== 'active') {
        // Already released / confirmed / expired – nothing to do
        return { seatIds: [] };
      }

      // Release the seats
      const { rows: seats } = await tx.query(
        `UPDATE seats
         SET    status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
         RETURNING id`,
        [holdId]
      );

      // Mark hold as released
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      return { seatIds: seats.map((s) => s.id) };
    });

    if (result.seatIds.length > 0) {
      broadcast('seats:released', {
        seats: result.seatIds.map((id) => ({ id, status: 'available' })),
      });
    }

    return res.json({ success: true, releasedSeatIds: result.seatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Expire stale holds inside an existing transaction context.
 * PGLite transactions expose the same query interface.
 */
async function expireStaleHoldsInTx(tx) {
  // Find expired held seats
  const { rows: expiredSeats } = await tx.query(`
    SELECT s.id, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return;

  const holdIds = [...new Set(expiredSeats.map((s) => s.hold_id).filter(Boolean))];

  await tx.query(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
  `);

  if (holdIds.length > 0) {
    const placeholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
    await tx.query(
      `UPDATE holds SET status = 'expired'
       WHERE  id IN (${placeholders}) AND status = 'active'`,
      holdIds
    );
  }
}

export default router;
