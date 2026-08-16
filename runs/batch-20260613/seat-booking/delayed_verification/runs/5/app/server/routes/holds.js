import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcastSeatUpdate } from '../sse.js';

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
    // Use a transaction for atomicity
    const result = await db.transaction(async (tx) => {
      // 1. Release expired holds first (inside the transaction)
      await releaseExpiredHoldsInTx(tx);

      // 2. Lock and read the requested seats
      //    FOR UPDATE ensures no concurrent transaction can modify these rows
      //    simultaneously.
      const seated = await tx.query(`
        SELECT id, status, hold_id, hold_expires_at
        FROM seats
        WHERE id = ANY($1)
        FOR UPDATE
      `, [seatIds]);

      // Verify all requested seats exist
      if (seated.rows.length !== seatIds.length) {
        const foundIds = new Set(seated.rows.map(r => r.id));
        const missing = seatIds.filter(id => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', missing };
      }

      // 3. Check for conflicts (any seat not available)
      const conflicts = seated.rows
        .filter(r => r.status !== 'available')
        .map(r => r.id);

      if (conflicts.length > 0) {
        throw { status: 409, error: 'Seats unavailable', conflicts };
      }

      // 4. Create the hold record
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(`
        INSERT INTO holds (id, session_id, status, expires_at)
        VALUES ($1, $2, 'active', $3)
      `, [holdId, sessionId, expiresAt.toISOString()]);

      // 5. Mark seats as held
      await tx.query(`
        UPDATE seats
        SET status = 'held',
            hold_id = $1,
            hold_expires_at = $2
        WHERE id = ANY($3)
      `, [holdId, expiresAt.toISOString(), seatIds]);

      // 6. Fetch updated seat rows for broadcast
      const updated = await tx.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM seats
        WHERE id = ANY($1)
      `, [seatIds]);

      return { holdId, expiresAt, updatedSeats: updated.rows };
    });

    // Broadcast outside the transaction
    broadcastSeatUpdate(result.updatedSeats);

    return res.status(201).json({
      holdId: result.holdId,
      sessionId,
      seatIds,
      expiresAt: result.expiresAt.toISOString(),
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        error: err.error,
        conflicts: err.conflicts,
      });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.error, missing: err.missing });
    }
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/holds/:holdId/confirm
 * Idempotently confirms a hold, booking all its seats.
 * - If already confirmed, returns the same booking result.
 * - If expired or unknown, returns 410/404.
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
      // 1. Release expired holds
      await releaseExpiredHoldsInTx(tx);

      // 2. Fetch the hold (lock it)
      const holdResult = await tx.query(`
        SELECT id, session_id, status, expires_at, confirmed_at
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdResult.rows[0];

      // 3. Ownership check
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      // 4. Idempotency: already confirmed
      if (hold.status === 'confirmed') {
        // Return the already-booked seats
        const bookedSeats = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
          FROM seats
          WHERE booked_by = $1
            AND hold_id = $2
        `, [sessionId, holdId]);
        return { alreadyConfirmed: true, seats: bookedSeats.rows, hold };
      }

      // 5. Reject released / expired holds
      if (hold.status === 'released' || hold.status === 'expired') {
        throw { status: 410, error: `Hold is ${hold.status}` };
      }

      // 6. Double-check expiry (belt-and-suspenders)
      const now = new Date();
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= now) {
        // Mark expired
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        throw { status: 410, error: 'Hold has expired' };
      }

      // 7. Verify seats still belong to this hold
      const heldSeats = await tx.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE hold_id = $1
        FOR UPDATE
      `, [holdId]);

      if (heldSeats.rows.length === 0) {
        throw { status: 410, error: 'No seats associated with this hold' };
      }

      const wrongSeats = heldSeats.rows.filter(
        s => s.status !== 'held' || s.hold_id !== holdId
      );
      if (wrongSeats.length > 0) {
        throw { status: 409, error: 'Seat state mismatch; hold may have been superseded' };
      }

      const seatIds = heldSeats.rows.map(s => s.id);

      // 8. Book the seats
      await tx.query(`
        UPDATE seats
        SET status = 'booked',
            booked_by = $1,
            hold_id = $2,
            hold_expires_at = NULL
        WHERE id = ANY($3)
      `, [sessionId, holdId, seatIds]);

      // 9. Mark hold confirmed
      await tx.query(`
        UPDATE holds
        SET status = 'confirmed',
            confirmed_at = NOW()
        WHERE id = $1
      `, [holdId]);

      // 10. Fetch updated seats for broadcast
      const updated = await tx.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM seats
        WHERE id = ANY($1)
      `, [seatIds]);

      return { alreadyConfirmed: false, seats: updated.rows, hold };
    });

    // Broadcast outside transaction
    if (result.seats.length > 0) {
      broadcastSeatUpdate(result.seats);
    }

    return res.json({
      success: true,
      holdId,
      sessionId,
      alreadyConfirmed: result.alreadyConfirmed,
      seats: result.seats.map(s => s.id),
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('POST /api/holds/:holdId/confirm error:', err);
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
      // Fetch hold
      const holdResult = await tx.query(`
        SELECT id, session_id, status
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdResult.rows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.status !== 'active') {
        throw { status: 409, error: `Hold is already ${hold.status}` };
      }

      // Release seats
      const seatsResult = await tx.query(`
        UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
        WHERE hold_id = $1
          AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `, [holdId]);

      // Mark hold released
      await tx.query(`
        UPDATE holds SET status = 'released' WHERE id = $1
      `, [holdId]);

      return seatsResult.rows;
    });

    broadcastSeatUpdate(result);

    return res.json({ success: true, holdId, releasedSeats: result.map(s => s.id) });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('DELETE /api/holds/:holdId error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Helper: release expired holds within an existing transaction context.
 * PGlite transactions pass a tx object; we reuse the same releaseExpiredHolds
 * logic but operate on the tx client.
 */
async function releaseExpiredHoldsInTx(tx) {
  const expired = await tx.query(`
    SELECT s.id, s.hold_id
    FROM seats s
    WHERE s.status = 'held'
      AND s.hold_expires_at IS NOT NULL
      AND s.hold_expires_at <= NOW()
  `);

  if (expired.rows.length === 0) return [];

  const holdIds = [...new Set(expired.rows.map(r => r.hold_id).filter(Boolean))];
  const seatIds = expired.rows.map(r => r.id);

  await tx.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE id = ANY($1)
  `, [seatIds]);

  if (holdIds.length > 0) {
    await tx.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE id = ANY($1)
        AND status = 'active'
    `, [holdIds]);
  }

  return seatIds;
}

export default router;
