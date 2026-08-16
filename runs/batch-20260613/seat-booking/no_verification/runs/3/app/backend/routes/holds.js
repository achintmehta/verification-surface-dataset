import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';
import { dbMutex } from '../mutex.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

/**
 * Broadcast any seats that were freed by expiry (called after COMMIT).
 */
function broadcastExpired(freedSeats) {
  if (freedSeats.length > 0) {
    broadcast('seats_released', {
      seats: freedSeats.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: 'available',
      })),
    });
  }
}

/**
 * Run expiry in its own committed transaction, then return freed seats.
 * This ensures expiry is durable even if the outer operation rolls back.
 */
async function commitExpiry(db) {
  await db.exec('BEGIN');
  try {
    const freed = await expireStaleHolds(db);
    await db.exec('COMMIT');
    return freed;
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

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

  return dbMutex.run(async () => {
    // Phase 1: commit any expired holds (durable regardless of what follows)
    const freedSeats = await commitExpiry(db);
    broadcastExpired(freedSeats);

    // Phase 2: atomically acquire the requested seats
    try {
      await db.exec('BEGIN');

      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seatRows } = await db.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );

      // Verify all requested seats exist
      if (seatRows.length !== seatIds.length) {
        await db.exec('ROLLBACK');
        const foundIds = new Set(seatRows.map(s => s.id));
        const missing = seatIds.filter(id => !foundIds.has(id));
        return res.status(400).json({ error: 'Unknown seat ids', missing });
      }

      // Check availability
      const unavailable = seatRows.filter(s => s.status !== 'available');

      if (unavailable.length > 0) {
        await db.exec('ROLLBACK');
        return res.status(409).json({
          error: 'One or more seats are unavailable',
          conflictingSeatIds: unavailable.map(s => s.id),
        });
      }

      // Create the hold record
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await db.query(
        `INSERT INTO holds (id, session_id, status, expires_at)
         VALUES ($1, $2, 'active', $3)`,
        [holdId, sessionId, expiresAt]
      );

      // Mark seats as held
      await db.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_expires_at = $2
         WHERE id IN (${placeholders})`,
        [holdId, expiresAt, ...seatIds]
      );

      await db.exec('COMMIT');

      broadcast('seats_held', {
        holdId,
        sessionId,
        expiresAt,
        seats: seatIds.map(id => ({ id, status: 'held' })),
      });

      return res.status(201).json({
        holdId,
        sessionId,
        expiresAt,
        seatIds,
        ttlSeconds: HOLD_TTL_SECONDS,
      });
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch {}
      console.error('[POST /api/holds]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});

/**
 * POST /api/holds/:holdId/confirm
 * Idempotently confirms a hold, booking all its seats.
 *
 * - If already confirmed → returns the existing booking (idempotent).
 * - If expired or unknown → 400/404.
 * - If active → books seats atomically.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  return dbMutex.run(async () => {
    // Phase 1: commit any expired holds
    const freedSeats = await commitExpiry(db);
    broadcastExpired(freedSeats);

    // Phase 2: confirm the hold
    try {
      await db.exec('BEGIN');

      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, status, expires_at FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        await db.exec('ROLLBACK');
        return res.status(403).json({ error: 'Session does not own this hold' });
      }

      // Idempotent: already confirmed
      if (hold.status === 'confirmed') {
        const { rows: bookedSeats } = await db.query(
          `SELECT id, row_label, seat_number, status FROM seats WHERE hold_id = $1`,
          [holdId]
        );
        await db.exec('COMMIT');
        return res.status(200).json({
          message: 'Already confirmed',
          holdId,
          sessionId,
          seats: bookedSeats,
        });
      }

      if (hold.status === 'expired' || hold.status === 'released') {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: `Hold is ${hold.status}` });
      }

      // Check expiry (the hold might have just expired between commitExpiry and now —
      // extremely unlikely but we guard against it)
      if (new Date(hold.expires_at) < new Date()) {
        await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        await db.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await db.exec('COMMIT');
        return res.status(400).json({ error: 'Hold has expired' });
      }

      // Verify seats still belong to this hold and are still held
      const { rows: heldSeats } = await db.query(
        `SELECT id, row_label, seat_number FROM seats
         WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: 'No held seats found for this hold' });
      }

      // Book the seats
      await db.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $1,
             hold_expires_at = NULL
         WHERE hold_id = $2 AND status = 'held'`,
        [sessionId, holdId]
      );

      // Mark hold as confirmed
      await db.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      await db.exec('COMMIT');

      broadcast('seats_booked', {
        holdId,
        sessionId,
        seats: heldSeats.map(s => ({ id: s.id, status: 'booked' })),
      });

      return res.status(200).json({
        message: 'Booking confirmed',
        holdId,
        sessionId,
        seats: heldSeats,
      });
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch {}
      console.error('[POST /api/holds/:holdId/confirm]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
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

  return dbMutex.run(async () => {
    // Phase 1: commit any expired holds
    const freedSeats = await commitExpiry(db);
    broadcastExpired(freedSeats);

    // Phase 2: release the hold
    try {
      await db.exec('BEGIN');

      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, status FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        await db.exec('ROLLBACK');
        return res.status(403).json({ error: 'Session does not own this hold' });
      }

      if (hold.status !== 'active') {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: `Hold is already ${hold.status}` });
      }

      // Release seats
      const { rows: releasedSeats } = await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );

      // Mark hold as released
      await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      await db.exec('COMMIT');

      broadcast('seats_released', {
        holdId,
        seats: releasedSeats.map(s => ({ id: s.id, status: 'available' })),
      });

      return res.status(200).json({
        message: 'Hold released',
        holdId,
        releasedSeats: releasedSeats.map(s => s.id),
      });
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch {}
      console.error('[DELETE /api/holds/:holdId]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});

export default router;
