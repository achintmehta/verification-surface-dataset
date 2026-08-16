import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

/**
 * Serialize all mutating operations through a simple async mutex so that
 * PGLite (which does not support true concurrent transactions) never has
 * two overlapping write transactions.
 */
let mutexPromise = Promise.resolve();

function withMutex(fn) {
  const next = mutexPromise.then(() => fn());
  // Swallow errors on the chain so one failure doesn't block subsequent ops
  mutexPromise = next.catch(() => {});
  return next;
}

/**
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently
 * available. On success, creates a hold with expires_at = now + TTL and
 * marks those seats held.
 *
 * If any requested seat is unavailable, acquires NONE and returns 409 with
 * the conflicting seat ids.
 */
router.post('/', (req, res) => {
  withMutex(async () => {
    try {
      const { seatIds, sessionId } = req.body;

      if (!Array.isArray(seatIds) || seatIds.length === 0) {
        return res.status(400).json({ error: 'seatIds must be a non-empty array' });
      }
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const db = await getDb();

      // --- Step 1: expire stale holds first ---
      const freed = await expireStaleHolds(db);
      if (freed.length > 0) {
        broadcast('released', freed);
      }

      // --- Step 2: check availability of all requested seats ---
      const quotedIds = seatIds.map(id => `'${escapeSql(id)}'`).join(', ');

      const { rows: seatRows } = await db.query(`
        SELECT id, status, hold_expires_at
        FROM   seats
        WHERE  id IN (${quotedIds})
      `);

      // Verify all requested seats exist
      if (seatRows.length !== seatIds.length) {
        const foundIds = new Set(seatRows.map(r => r.id));
        const missing = seatIds.filter(id => !foundIds.has(id));
        return res.status(400).json({ error: 'Unknown seat ids', missing });
      }

      // Find conflicts (seats that are not available)
      const conflicts = seatRows.filter(r => r.status !== 'available');
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'One or more seats are unavailable',
          conflictingSeatIds: conflicts.map(r => r.id),
        });
      }

      // --- Step 3: atomically mark all seats as held ---
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      // Insert hold record
      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, sessionId, expiresAt]
      );

      // Update seats – only if they are STILL available (guard against TOCTOU)
      const { rows: updatedSeats } = await db.query(`
        UPDATE seats
        SET    status          = 'held',
               hold_id         = '${escapeSql(holdId)}',
               hold_expires_at = '${expiresAt}'
        WHERE  id IN (${quotedIds})
          AND  status = 'available'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `);

      // If we didn't update all seats, another concurrent request snuck in
      if (updatedSeats.length !== seatIds.length) {
        // Roll back: release any seats we did manage to hold
        if (updatedSeats.length > 0) {
          const heldIds = updatedSeats.map(s => `'${s.id}'`).join(', ');
          await db.exec(`
            UPDATE seats
            SET    status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE  id IN (${heldIds})
          `);
        }
        // Remove the hold record
        await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

        // Determine which seats were the problem
        const updatedSet = new Set(updatedSeats.map(s => s.id));
        const conflictIds = seatIds.filter(id => !updatedSet.has(id));

        return res.status(409).json({
          error: 'One or more seats are unavailable',
          conflictingSeatIds: conflictIds,
        });
      }

      // --- Step 4: broadcast and respond ---
      broadcast('held', updatedSeats);

      return res.status(201).json({
        holdId,
        sessionId,
        seatIds: updatedSeats.map(s => s.id),
        expiresAt,
        ttlSeconds: HOLD_TTL_SECONDS,
      });
    } catch (err) {
      console.error('[POST /api/holds]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }).catch(err => {
    console.error('[POST /api/holds mutex]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });
});

/**
 * POST /api/holds/:holdId/confirm
 * Idempotent: confirming an already-confirmed hold returns the same booking.
 * Rejects expired or unknown holds.
 */
router.post('/:holdId/confirm', (req, res) => {
  withMutex(async () => {
    try {
      const { holdId } = req.params;
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const db = await getDb();

      // --- Step 1: expire stale holds ---
      const freed = await expireStaleHolds(db);
      if (freed.length > 0) {
        broadcast('released', freed);
      }

      // --- Step 2: look up the hold ---
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        return res.status(403).json({ error: 'Hold belongs to a different session' });
      }

      // --- Step 3: idempotency – already confirmed ---
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId]
        );
        return res.json({
          holdId,
          sessionId,
          bookedSeatIds: bookedSeats.map(s => s.id),
          alreadyConfirmed: true,
        });
      }

      // --- Step 4: check expiry ---
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= new Date()) {
        return res.status(410).json({ error: 'Hold has expired', holdId });
      }

      // --- Step 5: find seats owned by this hold ---
      const { rows: heldSeats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        return res.status(409).json({ error: 'No held seats found for this hold', holdId });
      }

      const heldIds = heldSeats.map(s => `'${s.id}'`).join(', ');

      // --- Step 6: atomically book the seats ---
      const { rows: bookedSeats } = await db.query(`
        UPDATE seats
        SET    status          = 'booked',
               hold_id         = NULL,
               hold_expires_at = NULL,
               booked_by       = '${escapeSql(holdId)}'
        WHERE  id IN (${heldIds})
          AND  hold_id = '${escapeSql(holdId)}'
          AND  status  = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `);

      if (bookedSeats.length !== heldSeats.length) {
        return res.status(409).json({
          error: 'Seat state changed during confirmation; please retry',
          holdId,
        });
      }

      // --- Step 7: mark hold as confirmed ---
      await db.query(`UPDATE holds SET confirmed = TRUE WHERE id = $1`, [holdId]);

      // --- Step 8: broadcast and respond ---
      broadcast('booked', bookedSeats);

      return res.json({
        holdId,
        sessionId,
        bookedSeatIds: bookedSeats.map(s => s.id),
        alreadyConfirmed: false,
      });
    } catch (err) {
      console.error('[POST /api/holds/:holdId/confirm]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }).catch(err => {
    console.error('[POST /api/holds/:holdId/confirm mutex]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });
});

/**
 * DELETE /api/holds/:holdId
 * Releases a hold early, returning its seats to available.
 */
router.delete('/:holdId', (req, res) => {
  withMutex(async () => {
    try {
      const { holdId } = req.params;
      const { sessionId } = req.body;

      const db = await getDb();

      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdRows[0];

      if (sessionId && hold.session_id !== sessionId) {
        return res.status(403).json({ error: 'Hold belongs to a different session' });
      }

      if (hold.confirmed) {
        return res.status(409).json({ error: 'Cannot release a confirmed (booked) hold' });
      }

      // Release the seats
      const { rows: releasedSeats } = await db.query(`
        UPDATE seats
        SET    status          = 'available',
               hold_id         = NULL,
               hold_expires_at = NULL
        WHERE  hold_id = '${escapeSql(holdId)}'
          AND  status  = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `);

      // Remove the hold record
      await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      if (releasedSeats.length > 0) {
        broadcast('released', releasedSeats);
      }

      return res.json({
        holdId,
        releasedSeatIds: releasedSeats.map(s => s.id),
      });
    } catch (err) {
      console.error('[DELETE /api/holds/:holdId]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }).catch(err => {
    console.error('[DELETE /api/holds/:holdId mutex]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });
});

/**
 * Minimal SQL injection guard for string interpolation.
 * (PGLite parameterized queries are used where possible; this covers
 * the remaining dynamic IN-list constructions.)
 */
function escapeSql(str) {
  return String(str).replace(/'/g, "''");
}

export default router;
