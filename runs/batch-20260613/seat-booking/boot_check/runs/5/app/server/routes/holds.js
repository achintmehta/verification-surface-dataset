import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

const HOLD_TTL_SECONDS = 60; // 60-second hold TTL

/**
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently available.
 * On success: creates a hold record, marks seats as held, returns hold info.
 * On conflict: acquires NONE and returns 409 with conflicting seat ids.
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
    // Use a transaction for atomicity
    const result = await db.transaction(async (tx) => {
      // 1. Sweep expired holds inside the transaction
      await releaseExpiredHolds(tx);

      // 2. Lock and check the requested seats
      //    SELECT FOR UPDATE ensures no concurrent transaction can modify these rows simultaneously
      const seatCheck = await tx.query(`
        SELECT id, status, hold_id, hold_expires_at
        FROM seats
        WHERE id = ANY($1::text[])
        FOR UPDATE
      `, [seatIds]);

      // Verify all requested seats exist
      if (seatCheck.rows.length !== seatIds.length) {
        const foundIds = new Set(seatCheck.rows.map(r => r.id));
        const missing = seatIds.filter(id => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', details: missing };
      }

      // Find unavailable seats (held or booked)
      const unavailable = seatCheck.rows.filter(r => r.status !== 'available');

      if (unavailable.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are unavailable',
          conflictingSeatIds: unavailable.map(r => r.id),
        };
      }

      // 3. All seats are available — create the hold
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(`
        INSERT INTO holds (id, session_id, expires_at)
        VALUES ($1, $2, $3)
      `, [holdId, sessionId, expiresAt.toISOString()]);

      // 4. Mark seats as held
      await tx.query(`
        UPDATE seats
        SET status = 'held',
            hold_id = $1,
            hold_expires_at = $2
        WHERE id = ANY($3::text[])
      `, [holdId, expiresAt.toISOString(), seatIds]);

      return { holdId, sessionId, seatIds, expiresAt };
    });

    // Broadcast the hold event
    broadcast('held', result.seatIds.map(id => ({
      id,
      status: 'held',
      holdId: result.holdId,
      expiresAt: result.expiresAt,
    })));

    res.status(201).json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.seatIds,
      expiresAt: result.expiresAt,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.error,
        conflictingSeatIds: err.conflictingSeatIds,
        details: err.details,
      });
    }
    console.error('[POST /api/holds]', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

/**
 * POST /api/holds/:holdId/confirm
 * Confirms a hold, booking the seats permanently.
 * Idempotent: confirming an already-confirmed hold returns the same booking.
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
      // 1. Sweep expired holds
      await releaseExpiredHolds(tx);

      // 2. Fetch the hold (lock it)
      const holdResult = await tx.query(`
        SELECT id, session_id, expires_at, confirmed
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found or has expired' };
      }

      const hold = holdResult.rows[0];

      // 3. Verify ownership
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      // 4. Check expiry
      if (new Date(hold.expires_at) <= new Date()) {
        throw { status: 410, error: 'Hold has expired' };
      }

      // 5. Idempotency: already confirmed
      if (hold.confirmed) {
        const bookedSeats = await tx.query(`
          SELECT id, row_label, seat_number, status, booked_by
          FROM seats
          WHERE hold_id = $1
        `, [holdId]);

        return { alreadyConfirmed: true, holdId, sessionId, seats: bookedSeats.rows };
      }

      // 6. Fetch and lock the seats belonging to this hold
      const seatsResult = await tx.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE hold_id = $1
        FOR UPDATE
      `, [holdId]);

      if (seatsResult.rows.length === 0) {
        throw { status: 409, error: 'No seats found for this hold' };
      }

      // Verify all seats are still held by this hold
      const badSeats = seatsResult.rows.filter(
        s => s.status !== 'held' || s.hold_id !== holdId
      );
      if (badSeats.length > 0) {
        throw { status: 409, error: 'Some seats are no longer held by this hold' };
      }

      // 7. Book the seats
      await tx.query(`
        UPDATE seats
        SET status = 'booked',
            booked_by = $1,
            hold_id = $2,
            hold_expires_at = NULL
        WHERE hold_id = $2
      `, [sessionId, holdId]);

      // 8. Mark hold as confirmed
      await tx.query(`
        UPDATE holds
        SET confirmed = TRUE
        WHERE id = $1
      `, [holdId]);

      const bookedSeats = seatsResult.rows.map(s => s.id);
      return { alreadyConfirmed: false, holdId, sessionId, seatIds: bookedSeats };
    });

    if (!result.alreadyConfirmed) {
      broadcast('booked', result.seatIds.map(id => ({
        id,
        status: 'booked',
        holdId: result.holdId,
        bookedBy: result.sessionId,
      })));
    }

    res.json({
      success: true,
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.alreadyConfirmed
        ? result.seats.map(s => s.id)
        : result.seatIds,
      alreadyConfirmed: result.alreadyConfirmed,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

/**
 * DELETE /api/holds/:holdId
 * Releases a hold early, returning its seats to available.
 */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // Fetch the hold
      const holdResult = await tx.query(`
        SELECT id, session_id, expires_at, confirmed
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdResult.rows[0];

      // Verify ownership if sessionId provided
      if (sessionId && hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release a confirmed (booked) hold' };
      }

      // Release the seats
      const seatsResult = await tx.query(`
        UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
        WHERE hold_id = $1
          AND status = 'held'
        RETURNING id, row_label, seat_number
      `, [holdId]);

      // Delete the hold record
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return { releasedSeats: seatsResult.rows };
    });

    broadcast('released', result.releasedSeats.map(s => ({
      id: s.id,
      status: 'available',
      holdId: null,
    })));

    res.json({
      success: true,
      holdId,
      releasedSeatIds: result.releasedSeats.map(s => s.id),
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

export { HOLD_TTL_SECONDS };
export default router;
