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
 * available. On success, creates a hold record and marks those seats held.
 * If any seat is unavailable, acquires NONE and returns 409 with conflicting ids.
 */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Sanitise seat ids (prevent SQL injection – ids are alphanumeric row+number)
  const safeSeatIds = seatIds.map((id) => String(id).replace(/[^A-Za-z0-9]/g, ''));
  if (safeSeatIds.some((id) => id.length === 0)) {
    return res.status(400).json({ error: 'Invalid seat id format' });
  }

  const db = await getDb();

  try {
    // Step 1: Expire stale holds in their own committed transaction first.
    // This ensures expiry is durable before we check availability.
    await db.exec('BEGIN');
    const freed = await expireStaleHolds(db);
    await db.exec('COMMIT');

    // Broadcast expiry releases (already committed)
    if (freed.length > 0) {
      broadcast('seats:released', { seats: freed });
    }

    // Step 2: Atomically acquire the requested seats
    await db.exec('BEGIN');

    const idList = safeSeatIds.map((id) => `'${id}'`).join(', ');

    // Lock and read the requested seats FOR UPDATE
    const { rows: seatRows } = await db.query(`
      SELECT id, row_label, seat_number, status, hold_expires_at
      FROM seats
      WHERE id IN (${idList})
      FOR UPDATE
    `);

    // Verify all requested seats exist
    if (seatRows.length !== safeSeatIds.length) {
      await db.exec('ROLLBACK');
      const foundIds = new Set(seatRows.map((s) => s.id));
      const missing = safeSeatIds.filter((id) => !foundIds.has(id));
      return res.status(404).json({ error: 'Unknown seat ids', missing });
    }

    // Check availability
    const unavailable = seatRows.filter((s) => {
      if (s.status === 'booked') return true;
      if (s.status === 'held') {
        const exp = s.hold_expires_at ? new Date(s.hold_expires_at) : null;
        return exp && exp > new Date();
      }
      return false;
    });

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'One or more seats are unavailable',
        conflictingSeatIds: unavailable.map((s) => s.id),
      });
    }

    // Create the hold record
    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
    const safeSession = String(sessionId).replace(/'/g, "''");

    await db.query(`
      INSERT INTO holds (id, session_id, status, expires_at)
      VALUES ('${holdId}', '${safeSession}', 'active', '${expiresAt}')
    `);

    // Mark seats as held
    await db.query(`
      UPDATE seats
      SET status          = 'held',
          hold_id         = '${holdId}',
          hold_expires_at = '${expiresAt}'
      WHERE id IN (${idList})
    `);

    await db.exec('COMMIT');

    // Broadcast the new holds
    const heldSeats = seatRows.map((s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: 'held',
      hold_id: holdId,
      hold_expires_at: expiresAt,
    }));
    broadcast('seats:held', { seats: heldSeats, holdId, sessionId, expiresAt });

    return res.status(201).json({
      holdId,
      sessionId,
      seatIds: safeSeatIds,
      expiresAt,
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
 * Idempotent: confirming an already-confirmed hold returns the same booking.
 * Rejects expired or unknown holds.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const safeHoldId = String(holdId).replace(/[^a-f0-9\-]/gi, '');
  const safeSession = String(sessionId).replace(/'/g, "''");

  const db = await getDb();

  try {
    // Step 1: Expire stale holds in their own committed transaction
    await db.exec('BEGIN');
    const freed = await expireStaleHolds(db);
    await db.exec('COMMIT');

    if (freed.length > 0) {
      broadcast('seats:released', { seats: freed });
    }

    // Step 2: Confirm the hold atomically
    await db.exec('BEGIN');

    // Lock the hold row
    const { rows: holdRows } = await db.query(`
      SELECT id, session_id, status, expires_at
      FROM holds
      WHERE id = '${safeHoldId}'
      FOR UPDATE
    `);

    if (holdRows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const hold = holdRows[0];

    // Ownership check
    if (hold.session_id !== safeSession) {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Hold belongs to a different session' });
    }

    // Idempotency: already confirmed
    if (hold.status === 'confirmed') {
      await db.exec('ROLLBACK');

      // Return the already-booked seats
      const { rows: bookedSeats } = await db.query(`
        SELECT id, row_label, seat_number, status, booked_by
        FROM seats
        WHERE hold_id = '${safeHoldId}'
      `);
      return res.json({
        message: 'Already confirmed',
        holdId: safeHoldId,
        seats: bookedSeats,
      });
    }

    // Reject released / expired holds
    if (hold.status === 'released' || hold.status === 'expired') {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: `Hold is ${hold.status}` });
    }

    // Check expiry (active hold but TTL elapsed)
    if (new Date(hold.expires_at) < new Date()) {
      // Mark it expired and free seats within this transaction
      await db.query(`UPDATE holds SET status = 'expired' WHERE id = '${safeHoldId}'`);
      const { rows: expiredSeats } = await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = '${safeHoldId}' AND status = 'held'
        RETURNING id, row_label, seat_number, status
      `);
      await db.exec('COMMIT');
      if (expiredSeats.length > 0) {
        broadcast('seats:released', { seats: expiredSeats });
      }
      return res.status(410).json({ error: 'Hold has expired' });
    }

    // Verify seats still belong to this hold and are still held
    const { rows: heldSeats } = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id
      FROM seats
      WHERE hold_id = '${safeHoldId}'
      FOR UPDATE
    `);

    if (heldSeats.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'No seats found for this hold' });
    }

    const notHeld = heldSeats.filter((s) => s.status !== 'held');
    if (notHeld.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'Some seats are no longer held by this hold',
        seats: notHeld.map((s) => s.id),
      });
    }

    // Book the seats
    await db.query(`
      UPDATE seats
      SET status          = 'booked',
          hold_expires_at = NULL,
          booked_by       = '${safeSession}'
      WHERE hold_id = '${safeHoldId}'
        AND status  = 'held'
    `);

    // Mark hold confirmed
    await db.query(`
      UPDATE holds SET status = 'confirmed' WHERE id = '${safeHoldId}'
    `);

    await db.exec('COMMIT');

    // Broadcast the bookings
    const bookedSeats = heldSeats.map((s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: 'booked',
      booked_by: safeSession,
    }));
    broadcast('seats:booked', { seats: bookedSeats, holdId: safeHoldId, sessionId: safeSession });

    return res.json({
      message: 'Booking confirmed',
      holdId: safeHoldId,
      seats: bookedSeats,
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

  const safeHoldId = String(holdId).replace(/[^a-f0-9\-]/gi, '');

  const db = await getDb();

  try {
    await db.exec('BEGIN');

    const { rows: holdRows } = await db.query(`
      SELECT id, session_id, status FROM holds
      WHERE id = '${safeHoldId}'
      FOR UPDATE
    `);

    if (holdRows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const hold = holdRows[0];

    // Optional ownership check when sessionId is provided
    if (sessionId && hold.session_id !== String(sessionId)) {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Hold belongs to a different session' });
    }

    if (hold.status !== 'active') {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: `Hold is already ${hold.status}` });
    }

    // Free the seats
    const { rows: freedSeats } = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = '${safeHoldId}' AND status = 'held'
      RETURNING id, row_label, seat_number, status
    `);

    await db.query(`UPDATE holds SET status = 'released' WHERE id = '${safeHoldId}'`);

    await db.exec('COMMIT');

    broadcast('seats:released', { seats: freedSeats, holdId: safeHoldId });

    return res.json({ message: 'Hold released', seats: freedSeats });
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch {}
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
