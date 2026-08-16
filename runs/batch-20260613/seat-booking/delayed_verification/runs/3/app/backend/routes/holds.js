import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/** Hold TTL in seconds – use env var for testing */
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '60', 10);

// ---------------------------------------------------------------------------
// POST /api/holds
// Body: { seatIds: string[], sessionId: string }
// Atomically acquires ALL requested seats or none.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    const db = await getDb();

    // Expire stale holds before attempting acquisition
    const released = await expireStaleHolds(db);
    if (released.length > 0) {
      broadcast('seats:released', { seatIds: released });
    }

    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    // --- Atomic all-or-nothing acquisition ---
    // We use a single UPDATE that only touches seats that are currently
    // 'available'. Then we check whether the count matches what was requested.
    // If not, we roll back by releasing any seats we just grabbed.
    //
    // PGLite is single-connection so JS-level serialisation is guaranteed,
    // but we still use a transaction for atomicity of the multi-step logic.

    await db.exec('BEGIN');

    try {
      // Lock and update only the seats that are available right now
      const { rows: updated } = await db.query(`
        UPDATE seats
        SET    status          = 'held',
               hold_id         = $1,
               hold_expires_at = $2
        WHERE  id = ANY($3::text[])
          AND  status = 'available'
        RETURNING id
      `, [holdId, expiresAt.toISOString(), uniqueSeatIds]);

      const acquiredIds = updated.map((r) => r.id);

      if (acquiredIds.length !== uniqueSeatIds.length) {
        // Compute conflicting seats as those we requested but did NOT acquire.
        // We must NOT re-query status here because the partial UPDATE already
        // changed some seats to 'held' with our holdId, which would give a
        // false positive for seats that were actually available.
        const acquiredSet = new Set(acquiredIds);
        const conflictingSeatIds = uniqueSeatIds.filter((id) => !acquiredSet.has(id));

        // Roll back everything – ROLLBACK undoes the partial UPDATE
        await db.exec('ROLLBACK');

        return res.status(409).json({
          error: 'One or more seats are unavailable',
          conflictingSeatIds,
        });
      }

      // All seats acquired – persist the hold record
      await db.query(`
        INSERT INTO holds (id, session_id, expires_at, confirmed)
        VALUES ($1, $2, $3, FALSE)
      `, [holdId, sessionId, expiresAt.toISOString()]);

      await db.exec('COMMIT');

      // Broadcast the hold event
      broadcast('seats:held', {
        seatIds: acquiredIds,
        holdId,
        expiresAt: expiresAt.toISOString(),
        sessionId,
      });

      return res.status(201).json({
        holdId,
        seatIds: acquiredIds,
        sessionId,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: HOLD_TTL_SECONDS,
      });
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[POST /api/holds]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// Idempotent: confirming an already-confirmed hold returns the same booking.
// ---------------------------------------------------------------------------
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    // Expire stale holds before confirming
    const released = await expireStaleHolds(db);
    if (released.length > 0) {
      broadcast('seats:released', { seatIds: released });
    }

    await db.exec('BEGIN');

    try {
      // Fetch the hold
      const { rows: holdRows } = await db.query(`
        SELECT id, session_id, expires_at, confirmed
        FROM   holds
        WHERE  id = $1
      `, [holdId]);

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found or already expired' });
      }

      const hold = holdRows[0];

      // Ownership check
      if (hold.session_id !== sessionId) {
        await db.exec('ROLLBACK');
        return res.status(403).json({ error: 'Session does not own this hold' });
      }

      // Idempotency: already confirmed
      if (hold.confirmed) {
        // Return the already-booked seats
        const { rows: bookedSeats } = await db.query(`
          SELECT id, row_label, seat_number, status, booked_by
          FROM   seats
          WHERE  booked_by = $1
        `, [holdId]);

        await db.exec('ROLLBACK');
        return res.status(200).json({
          message: 'Already confirmed',
          holdId,
          seats: bookedSeats,
        });
      }

      // Expiry check
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= new Date()) {
        await db.exec('ROLLBACK');
        return res.status(410).json({ error: 'Hold has expired' });
      }

      // Confirm: book the seats that are currently held by this hold
      const { rows: bookedSeats } = await db.query(`
        UPDATE seats
        SET    status          = 'booked',
               booked_by       = $1,
               hold_id         = NULL,
               hold_expires_at = NULL
        WHERE  hold_id = $2
          AND  status  = 'held'
        RETURNING id, row_label, seat_number, status, booked_by
      `, [holdId, holdId]);

      if (bookedSeats.length === 0) {
        // The hold existed but no seats are held by it (race: expired between
        // our expiry sweep and now)
        await db.exec('ROLLBACK');
        return res.status(410).json({ error: 'Hold seats are no longer available' });
      }

      // Mark hold as confirmed
      await db.query(`
        UPDATE holds SET confirmed = TRUE WHERE id = $1
      `, [holdId]);

      await db.exec('COMMIT');

      const bookedSeatIds = bookedSeats.map((s) => s.id);

      // Broadcast
      broadcast('seats:booked', {
        seatIds: bookedSeatIds,
        holdId,
        sessionId,
      });

      return res.status(200).json({
        message: 'Booking confirmed',
        holdId,
        seats: bookedSeats,
      });
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[POST /api/holds/:holdId/confirm]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// Release a hold early, returning its seats to available.
// ---------------------------------------------------------------------------
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    await db.exec('BEGIN');

    try {
      const { rows: holdRows } = await db.query(`
        SELECT id, session_id, confirmed FROM holds WHERE id = $1
      `, [holdId]);

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        await db.exec('ROLLBACK');
        return res.status(403).json({ error: 'Session does not own this hold' });
      }

      if (hold.confirmed) {
        await db.exec('ROLLBACK');
        return res.status(409).json({ error: 'Cannot release a confirmed hold' });
      }

      // Release seats
      const { rows: releasedSeats } = await db.query(`
        UPDATE seats
        SET    status = 'available',
               hold_id = NULL,
               hold_expires_at = NULL
        WHERE  hold_id = $1
          AND  status  = 'held'
        RETURNING id
      `, [holdId]);

      // Remove hold record
      await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      await db.exec('COMMIT');

      const releasedIds = releasedSeats.map((s) => s.id);

      if (releasedIds.length > 0) {
        broadcast('seats:released', { seatIds: releasedIds });
      }

      return res.status(200).json({
        message: 'Hold released',
        holdId,
        releasedSeatIds: releasedIds,
      });
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[DELETE /api/holds/:holdId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
