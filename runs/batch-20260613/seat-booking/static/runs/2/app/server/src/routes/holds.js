/**
 * Hold routes:
 *
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { transaction } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';
import { HOLD_TTL_SECONDS } from '../schema.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/holds
// Body: { seatIds: string[], sessionId: string }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  // --- Input validation ---
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array.' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  // Deduplicate
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    // Lazy expiry before acquiring
    await releaseExpiredHolds();

    const result = await transaction(async (db) => {
      // Lock the requested seats FOR UPDATE to prevent concurrent acquisition
      // We use a parameterised ANY($1) with a text array.
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await db.query(
        `SELECT id, status, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders})
         ORDER BY id
         FOR UPDATE`,
        uniqueSeatIds
      );

      // Check all requested seats exist
      if (seats.length !== uniqueSeatIds.length) {
        const found = new Set(seats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !found.has(id));
        throw { status: 400, error: 'Unknown seat ids.', missing };
      }

      // Identify unavailable seats (held with a valid (non-expired) hold, or booked)
      const now = new Date();
      const conflicting = seats.filter((s) => {
        if (s.status === 'booked') return true;
        if (s.status === 'held') {
          // If the hold is expired treat it as available (will be swept later)
          const exp = s.hold_expires_at ? new Date(s.hold_expires_at) : null;
          return exp === null || exp > now;
        }
        return false;
      });

      if (conflicting.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are unavailable.',
          conflictingSeatIds: conflicting.map((s) => s.id),
        };
      }

      // All seats are available – create the hold
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await db.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // Mark every seat as held
      for (const seatId of uniqueSeatIds) {
        await db.query(
          `UPDATE seats
           SET    status = 'held',
                  hold_id = $1,
                  hold_expires_at = $2
           WHERE  id = $3`,
          [holdId, expiresAt.toISOString(), seatId]
        );
      }

      return { holdId, sessionId, seatIds: uniqueSeatIds, expiresAt };
    });

    // Broadcast each newly held seat
    for (const seatId of result.seatIds) {
      broadcast('seat-update', {
        id: seatId,
        status: 'held',
        holdId: result.holdId,
        expiresAt: result.expiresAt,
      });
    }

    return res.status(201).json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.seatIds,
      expiresAt: result.expiresAt,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: err.error,
        ...(err.conflictingSeatIds && { conflictingSeatIds: err.conflictingSeatIds }),
        ...(err.missing && { missing: err.missing }),
      });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Failed to create hold.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// Body: { sessionId: string }
// ---------------------------------------------------------------------------
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    // Lazy expiry before confirming
    await releaseExpiredHolds();

    const result = await transaction(async (db) => {
      // Fetch the hold (lock it)
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found or already expired.' };
      }

      const hold = holdRows[0];

      // Ownership check
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'This hold belongs to a different session.' };
      }

      // Expiry check
      if (new Date(hold.expires_at) < new Date()) {
        throw { status: 410, error: 'Hold has expired.' };
      }

      // Idempotency: already confirmed → return the booked seats without re-booking
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId]
        );
        return { alreadyConfirmed: true, seatIds: bookedSeats.map((s) => s.id), holdId };
      }

      // Fetch the seats owned by this hold (lock them)
      const { rows: heldSeats } = await db.query(
        `SELECT id, status
         FROM   seats
         WHERE  hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        throw { status: 409, error: 'No seats are associated with this hold.' };
      }

      // Verify every seat is still held by this hold
      const notHeld = heldSeats.filter((s) => s.status !== 'held');
      if (notHeld.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are no longer held by this hold.',
          seatIds: notHeld.map((s) => s.id),
        };
      }

      // Book the seats
      for (const seat of heldSeats) {
        await db.query(
          `UPDATE seats
           SET    status = 'booked',
                  hold_id = NULL,
                  hold_expires_at = NULL,
                  booked_by = $1
           WHERE  id = $2`,
          [holdId, seat.id]
        );
      }

      // Mark the hold as confirmed
      await db.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return {
        alreadyConfirmed: false,
        seatIds: heldSeats.map((s) => s.id),
        holdId,
        sessionId,
      };
    });

    // Broadcast booked seats (only if this was a fresh confirmation)
    if (!result.alreadyConfirmed) {
      for (const seatId of result.seatIds) {
        broadcast('seat-update', { id: seatId, status: 'booked', bookedBy: holdId });
      }
    }

    return res.status(200).json({
      success: true,
      holdId: result.holdId,
      seatIds: result.seatIds,
      alreadyConfirmed: result.alreadyConfirmed,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: err.error,
        ...(err.seatIds && { seatIds: err.seatIds }),
      });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Failed to confirm hold.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// Body: { sessionId: string }
// ---------------------------------------------------------------------------
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    const freedSeatIds = await transaction(async (db) => {
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found.' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'This hold belongs to a different session.' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release a confirmed hold.' };
      }

      // Free the seats
      const { rows: seats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      for (const seat of seats) {
        await db.query(
          `UPDATE seats
           SET    status = 'available',
                  hold_id = NULL,
                  hold_expires_at = NULL
           WHERE  id = $1`,
          [seat.id]
        );
      }

      await db.query('DELETE FROM holds WHERE id = $1', [holdId]);

      return seats.map((s) => s.id);
    });

    // Broadcast released seats
    for (const seatId of freedSeatIds) {
      broadcast('seat-update', { id: seatId, status: 'available' });
    }

    return res.status(200).json({ success: true, freedSeatIds });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Failed to release hold.' });
  }
});

export default router;
