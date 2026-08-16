/**
 * Hold routes:
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/** Hold TTL in seconds */
const HOLD_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// POST /api/holds
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  if (
    !Array.isArray(seatIds) ||
    seatIds.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.trim() === ''
  ) {
    return res.status(400).json({
      error: 'seatIds (non-empty array) and sessionId (string) are required.',
    });
  }

  // Deduplicate
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    // Lazily release expired holds before attempting acquisition
    await releaseExpiredHolds();

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

    const result = await transaction(async (tx) => {
      // -----------------------------------------------------------------------
      // 1. Lock and inspect every requested seat inside the transaction.
      //    We use FOR UPDATE to prevent concurrent transactions from reading
      //    stale data for the same rows.
      //    Because all queries are serialised through our queue, this is
      //    belt-and-suspenders but keeps the SQL semantically correct.
      // -----------------------------------------------------------------------
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seatRows } = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      // Verify all requested seats exist
      if (seatRows.length !== uniqueSeatIds.length) {
        const foundIds = new Set(seatRows.map((r) => r.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        throw { statusCode: 404, error: 'Unknown seat ids', seatIds: missing };
      }

      const now = new Date();

      // Determine which seats are genuinely unavailable
      const conflicting = seatRows.filter((seat) => {
        if (seat.status === 'booked') return true;
        if (seat.status === 'held') {
          // Treat expired holds as available
          if (seat.hold_expires_at && new Date(seat.hold_expires_at) <= now) {
            return false;
          }
          return true;
        }
        return false; // available
      });

      if (conflicting.length > 0) {
        throw {
          statusCode: 409,
          error: 'One or more seats are unavailable.',
          conflictingSeatIds: conflicting.map((s) => s.id),
        };
      }

      // -----------------------------------------------------------------------
      // 2. Release any expired holds on the seats we are about to acquire
      //    (they passed the expiry check above but their DB row is still held).
      // -----------------------------------------------------------------------
      const expiredHoldIds = [
        ...new Set(
          seatRows
            .filter(
              (s) =>
                s.status === 'held' &&
                s.hold_expires_at &&
                new Date(s.hold_expires_at) <= now
            )
            .map((s) => s.hold_id)
            .filter(Boolean)
        ),
      ];

      for (const expiredId of expiredHoldIds) {
        await tx.query(
          `UPDATE seats
           SET    status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE  hold_id = $1 AND status = 'held'`,
          [expiredId]
        );
      }

      // -----------------------------------------------------------------------
      // 3. Create the hold record
      // -----------------------------------------------------------------------
      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, sessionId.trim(), expiresAt.toISOString()]
      );

      // -----------------------------------------------------------------------
      // 4. Atomically mark every requested seat as held
      // -----------------------------------------------------------------------
      for (const seatId of uniqueSeatIds) {
        await tx.query(
          `UPDATE seats
           SET    status          = 'held',
                  hold_id         = $1,
                  hold_expires_at = $2
           WHERE  id     = $3
             AND  status IN ('available', 'held')`,
          [holdId, expiresAt.toISOString(), seatId]
        );
      }

      return { holdId, expiresAt };
    });

    // Broadcast the new holds to all SSE clients
    broadcast('seats_held', {
      holdId: result.holdId,
      seatIds: uniqueSeatIds,
      sessionId: sessionId.trim(),
      expiresAt: result.expiresAt.toISOString(),
    });

    return res.status(201).json({
      holdId: result.holdId,
      seatIds: uniqueSeatIds,
      sessionId: sessionId.trim(),
      expiresAt: result.expiresAt.toISOString(),
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        ...(err.conflictingSeatIds && {
          conflictingSeatIds: err.conflictingSeatIds,
        }),
        ...(err.seatIds && { seatIds: err.seatIds }),
      });
    }
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// ---------------------------------------------------------------------------

router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId (string) is required.' });
  }

  try {
    // Lazily release expired holds first
    await releaseExpiredHolds();

    const result = await transaction(async (tx) => {
      // -----------------------------------------------------------------------
      // 1. Fetch and lock the hold
      // -----------------------------------------------------------------------
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { statusCode: 404, error: 'Hold not found.' };
      }

      const hold = holdRows[0];

      // Ownership check
      if (hold.session_id !== sessionId.trim()) {
        throw { statusCode: 403, error: 'Hold belongs to a different session.' };
      }

      // -----------------------------------------------------------------------
      // 2. Idempotency: already confirmed → return existing booking
      // -----------------------------------------------------------------------
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1`,
          [holdId]
        );
        return {
          alreadyConfirmed: true,
          holdId,
          seatIds: bookedSeats.map((s) => s.id),
          sessionId: hold.session_id,
        };
      }

      // -----------------------------------------------------------------------
      // 3. Expiry check
      // -----------------------------------------------------------------------
      if (new Date(hold.expires_at) <= new Date()) {
        throw { statusCode: 410, error: 'Hold has expired.' };
      }

      // -----------------------------------------------------------------------
      // 4. Verify the hold still owns its seats (they haven't been stolen)
      // -----------------------------------------------------------------------
      const { rows: heldSeats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        throw {
          statusCode: 409,
          error: 'No held seats found for this hold. It may have expired.',
        };
      }

      const seatIds = heldSeats.map((s) => s.id);

      // -----------------------------------------------------------------------
      // 5. Book the seats
      // -----------------------------------------------------------------------
      await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                hold_id         = NULL,
                hold_expires_at = NULL,
                booked_by       = $1
         WHERE  hold_id = $2
           AND  status  = 'held'`,
        [holdId, holdId]
      );

      // -----------------------------------------------------------------------
      // 6. Mark the hold as confirmed
      // -----------------------------------------------------------------------
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return {
        alreadyConfirmed: false,
        holdId,
        seatIds,
        sessionId: hold.session_id,
      };
    });

    // Broadcast booking to all SSE clients
    broadcast('seats_booked', {
      holdId: result.holdId,
      seatIds: result.seatIds,
      sessionId: result.sessionId,
    });

    return res.status(200).json({
      holdId: result.holdId,
      seatIds: result.seatIds,
      sessionId: result.sessionId,
      booked: true,
    });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.error });
    }
    console.error(`POST /api/holds/${req.params.holdId}/confirm error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// ---------------------------------------------------------------------------

router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId (string) is required.' });
  }

  try {
    const result = await transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { statusCode: 404, error: 'Hold not found.' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId.trim()) {
        throw { statusCode: 403, error: 'Hold belongs to a different session.' };
      }

      if (hold.confirmed) {
        throw { statusCode: 409, error: 'Cannot release a confirmed hold.' };
      }

      // Release the seats
      const { rows: releasedSeats } = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'
         RETURNING id`,
        [holdId]
      );

      // Delete the hold record
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return releasedSeats.map((s) => s.id);
    });

    broadcast('seats_released', {
      holdId,
      seatIds: result,
      reason: 'released',
    });

    return res.status(200).json({
      holdId,
      seatIds: result,
      released: true,
    });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.error });
    }
    console.error(`DELETE /api/holds/${req.params.holdId} error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
