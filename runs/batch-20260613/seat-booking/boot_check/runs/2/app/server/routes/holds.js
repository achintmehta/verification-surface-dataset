import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, HOLD_TTL_SECONDS } from '../db.js';
import { expireHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently
 * available. On success, creates a hold with expires_at = now + TTL and
 * marks those seats as held.
 *
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
    let holdResult = null;
    let conflictIds = [];

    await db.transaction(async (tx) => {
      // 1. Expire stale holds first (inside transaction for consistency)
      await tx.query(`
        UPDATE seats
        SET    status          = 'available',
               hold_id         = NULL,
               hold_expires_at = NULL
        WHERE  status = 'held'
          AND  hold_expires_at <= NOW()
      `);

      // 2. Lock and read the requested seats
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      // 3. Check all requested seats exist
      if (seats.length !== seatIds.length) {
        const foundIds = new Set(seats.map((s) => s.id));
        const missing = seatIds.filter((id) => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', seatIds: missing };
      }

      // 4. Identify unavailable seats (held with valid TTL, or booked)
      const unavailable = seats.filter((s) => {
        if (s.status === 'booked') return true;
        if (s.status === 'held') {
          // If hold is expired it was already cleared above, but double-check
          const exp = s.hold_expires_at ? new Date(s.hold_expires_at) : null;
          return exp && exp > new Date();
        }
        return false;
      });

      if (unavailable.length > 0) {
        conflictIds = unavailable.map((s) => s.id);
        throw { status: 409, error: 'Seats unavailable', conflictIds };
      }

      // 5. All seats are available – create hold and mark seats
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(', ');
      await tx.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = $2,
                booked_by       = $3
         WHERE  id IN (${updatePlaceholders})`,
        [holdId, expiresAt.toISOString(), sessionId, ...seatIds]
      );

      holdResult = {
        holdId,
        sessionId,
        seatIds,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: HOLD_TTL_SECONDS,
      };
    });

    // Broadcast held seats to all SSE clients
    if (holdResult) {
      broadcast('seats:held', {
        holdId: holdResult.holdId,
        sessionId: holdResult.sessionId,
        seatIds: holdResult.seatIds,
        expiresAt: holdResult.expiresAt,
      });
      return res.status(201).json(holdResult);
    }
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.error, conflictIds: err.conflictIds });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.error, seatIds: err.seatIds });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Failed to create hold' });
  }
});

/**
 * POST /api/holds/:holdId/confirm
 * Idempotently confirms a hold, booking all its seats.
 *
 * - If already confirmed, returns the same booking result (idempotent).
 * - If expired or unknown, returns 410 / 404.
 * - If valid, marks seats as booked inside a transaction.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    let result = null;

    await db.transaction(async (tx) => {
      // 1. Fetch the hold record (lock it)
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      // 2. Idempotency: already confirmed
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM   seats
           WHERE  hold_id = $1`,
          [holdId]
        );
        result = { holdId, sessionId, seats: bookedSeats, alreadyConfirmed: true };
        return;
      }

      // 3. Check expiry
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= new Date()) {
        throw { status: 410, error: 'Hold has expired', expiredAt: hold.expires_at };
      }

      // 4. Fetch seats that belong to this hold and are still held
      const { rows: heldSeats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        throw { status: 410, error: 'No seats found for this hold (may have expired)' };
      }

      // Verify all seats are still held by this hold
      const notHeld = heldSeats.filter((s) => s.status !== 'held' || s.hold_id !== holdId);
      if (notHeld.length > 0) {
        throw { status: 409, error: 'Some seats are no longer held by this hold', seatIds: notHeld.map((s) => s.id) };
      }

      const seatIds = heldSeats.map((s) => s.id);
      const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(', ');

      // 5. Book the seats
      await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                hold_expires_at = NULL
         WHERE  id IN (${placeholders})
           AND  hold_id = $1`,
        [holdId, ...seatIds]
      );

      // 6. Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      result = {
        holdId,
        sessionId,
        seats: heldSeats.map((s) => ({ ...s, status: 'booked', hold_expires_at: null })),
        alreadyConfirmed: false,
      };
    });

    if (result) {
      if (!result.alreadyConfirmed) {
        broadcast('seats:booked', {
          holdId: result.holdId,
          sessionId: result.sessionId,
          seatIds: result.seats.map((s) => s.id),
        });
      }
      return res.json(result);
    }
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, ...(err.expiredAt && { expiredAt: err.expiredAt }), ...(err.seatIds && { seatIds: err.seatIds }) });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Failed to confirm hold' });
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
    let releasedSeatIds = [];

    await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release a confirmed (booked) hold' };
      }

      // Release seats
      const { rows: seats } = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'
         RETURNING id`,
        [holdId]
      );

      releasedSeatIds = seats.map((s) => s.id);

      // Delete the hold record
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);
    });

    broadcast('seats:released', {
      holdId,
      seatIds: releasedSeatIds,
    });

    return res.json({ holdId, releasedSeatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Failed to release hold' });
  }
});

export default router;
