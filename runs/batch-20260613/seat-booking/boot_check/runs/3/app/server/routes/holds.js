import { Router } from 'express';
import { randomUUID } from 'crypto';
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
 * available. If any seat is unavailable, acquires none and returns 409.
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
    // Expire stale holds before attempting acquisition
    const freed = await expireStaleHolds(db);
    if (freed.length > 0) {
      broadcast('seats:released', {
        seats: freed.map((s) => ({ ...s, status: 'available' })),
      });
    }

    // Build a quoted list for SQL IN clause
    const quotedIds = seatIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

    // --- Atomic check-and-set inside a transaction ---
    await db.exec('BEGIN');

    // Lock the target rows and read their current effective status
    const { rows: targetSeats } = await db.query(`
      SELECT
        id,
        status,
        hold_expires_at
      FROM seats
      WHERE id IN (${quotedIds})
      FOR UPDATE
    `);

    // Verify we found all requested seats
    if (targetSeats.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      const foundIds = new Set(targetSeats.map((s) => s.id));
      const missing = seatIds.filter((id) => !foundIds.has(id));
      return res.status(404).json({ error: 'Unknown seat ids', missing });
    }

    // Determine which seats are effectively unavailable
    const now = new Date();
    const conflicting = targetSeats.filter((s) => {
      if (s.status === 'booked') return true;
      if (s.status === 'held') {
        // A held seat is only truly unavailable if its hold hasn't expired
        const exp = s.hold_expires_at ? new Date(s.hold_expires_at) : null;
        return exp && exp > now;
      }
      return false;
    });

    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'One or more seats are unavailable',
        conflictingSeatIds: conflicting.map((s) => s.id),
      });
    }

    // All seats are available – create the hold and mark seats
    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    await db.query(
      `INSERT INTO holds (id, session_id, status, expires_at)
       VALUES ($1, $2, 'active', $3)`,
      [holdId, sessionId, expiresAt.toISOString()]
    );

    await db.exec(`
      UPDATE seats
      SET status = 'held',
          hold_id = '${holdId}',
          hold_expires_at = '${expiresAt.toISOString()}'
      WHERE id IN (${quotedIds})
    `);

    await db.exec('COMMIT');

    // Broadcast the newly held seats
    broadcast('seats:held', {
      holdId,
      sessionId,
      expiresAt: expiresAt.toISOString(),
      seats: seatIds.map((id) => ({ id, status: 'held' })),
    });

    return res.status(201).json({
      holdId,
      sessionId,
      expiresAt: expiresAt.toISOString(),
      seatIds,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch {}
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/holds/:holdId/confirm
 * Idempotently confirms a hold, booking its seats permanently.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    await db.exec('BEGIN');

    // Lock the hold row
    const { rows: holdRows } = await db.query(
      `SELECT id, session_id, status, expires_at
       FROM holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const hold = holdRows[0];

    // Ownership check
    if (hold.session_id !== sessionId) {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Hold belongs to a different session' });
    }

    // Idempotency: already confirmed
    if (hold.status === 'confirmed') {
      const { rows: bookedSeats } = await db.query(
        `SELECT id, row_label, seat_number, status, booked_by
         FROM seats WHERE hold_id = $1`,
        [holdId]
      );
      await db.exec('ROLLBACK');
      return res.status(200).json({
        message: 'Already confirmed',
        holdId,
        seats: bookedSeats,
      });
    }

    // Reject released / expired holds
    if (hold.status === 'released' || hold.status === 'expired') {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: `Hold is ${hold.status}` });
    }

    // Check expiry
    const now = new Date();
    const expiresAt = new Date(hold.expires_at);
    if (expiresAt <= now) {
      // Mark as expired
      await db.exec(`UPDATE holds SET status = 'expired' WHERE id = '${holdId}'`);
      // Release the seats
      await db.exec(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = '${holdId}' AND status = 'held'
      `);
      await db.exec('COMMIT');
      return res.status(410).json({ error: 'Hold has expired' });
    }

    // Confirm: book the seats
    const { rows: seats } = await db.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = $1,
           hold_expires_at = NULL
       WHERE hold_id = $2
         AND status = 'held'
       RETURNING id, row_label, seat_number, status, booked_by`,
      [sessionId, holdId]
    );

    if (seats.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'No held seats found for this hold' });
    }

    // Mark hold as confirmed
    await db.exec(`UPDATE holds SET status = 'confirmed' WHERE id = '${holdId}'`);

    await db.exec('COMMIT');

    // Broadcast
    broadcast('seats:booked', {
      holdId,
      sessionId,
      seats: seats.map((s) => ({ id: s.id, status: 'booked', booked_by: s.booked_by })),
    });

    return res.status(200).json({
      message: 'Booking confirmed',
      holdId,
      seats,
    });
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch {}
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

  const db = await getDb();

  try {
    await db.exec('BEGIN');

    const { rows: holdRows } = await db.query(
      `SELECT id, session_id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const hold = holdRows[0];

    if (sessionId && hold.session_id !== sessionId) {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Hold belongs to a different session' });
    }

    if (hold.status !== 'active') {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: `Hold is already ${hold.status}` });
    }

    // Release seats
    const { rows: releasedSeats } = await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number`,
      [holdId]
    );

    await db.exec(`UPDATE holds SET status = 'released' WHERE id = '${holdId}'`);

    await db.exec('COMMIT');

    broadcast('seats:released', {
      holdId,
      seats: releasedSeats.map((s) => ({ ...s, status: 'available' })),
    });

    return res.status(200).json({ message: 'Hold released', seats: releasedSeats });
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch {}
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
