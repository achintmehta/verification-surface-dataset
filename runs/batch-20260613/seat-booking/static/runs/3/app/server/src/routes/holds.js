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
import { releaseExpiredHoldsTx } from '../expiry.js';
import { broadcast } from '../sse.js';
import { HOLD_TTL_SECONDS } from '../schema.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/holds
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  // --- Input validation ---
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate seat ids.
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    // These are populated inside the transaction and read after it commits.
    let holdRecord = null;
    let heldSeatIds = [];
    let expiredSeatIds = [];

    await transaction(async (tx) => {
      // 1. Release any expired holds first (inside the transaction).
      expiredSeatIds = await releaseExpiredHoldsTx(tx);

      // 2. Inspect the requested seats.
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders})`,
        uniqueSeatIds,
      );

      // Verify all requested seats exist.
      if (seats.length !== uniqueSeatIds.length) {
        const foundIds = new Set(seats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        throw Object.assign(new Error('Unknown seat ids'), { status: 400, missing });
      }

      // Identify unavailable seats (held or booked).
      const conflicting = seats.filter((s) => s.status !== 'available').map((s) => s.id);
      if (conflicting.length > 0) {
        // All-or-nothing: acquire none.
        throw Object.assign(new Error('Seats unavailable'), {
          status: 409,
          conflictingSeatIds: conflicting,
        });
      }

      // 3. Create the hold record.
      const holdId = uuidv4();
      const { rows: holdRows } = await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)
         RETURNING id, session_id, expires_at, confirmed`,
        [holdId, sessionId.trim(), String(HOLD_TTL_SECONDS)],
      );
      holdRecord = holdRows[0];

      // 4. Mark every requested seat as held.
      for (const seatId of uniqueSeatIds) {
        await tx.query(
          `UPDATE seats
           SET    status          = 'held',
                  hold_id         = $1,
                  hold_expires_at = $2
           WHERE  id     = $3
             AND  status = 'available'`,
          [holdId, holdRecord.expires_at, seatId],
        );
      }

      // 5. Verify all seats are now held by our hold (concurrency safety check).
      const { rows: updatedSeats } = await tx.query(
        `SELECT id, status, hold_id FROM seats WHERE id IN (${placeholders})`,
        uniqueSeatIds,
      );

      const notHeld = updatedSeats.filter(
        (s) => s.status !== 'held' || s.hold_id !== holdRecord.id,
      );
      if (notHeld.length > 0) {
        throw Object.assign(new Error('Concurrent modification detected'), {
          status: 409,
          conflictingSeatIds: notHeld.map((s) => s.id),
        });
      }

      heldSeatIds = updatedSeats.map((s) => s.id);
    });

    // --- Transaction committed ---

    // Broadcast seats released by expiry.
    if (expiredSeatIds.length > 0) {
      broadcast('seats:released', { seatIds: expiredSeatIds });
    }

    // Broadcast the newly held seats.
    broadcast('seats:held', {
      holdId: holdRecord.id,
      seatIds: heldSeatIds,
      expiresAt: holdRecord.expires_at,
    });

    return res.status(201).json({
      hold: {
        id: holdRecord.id,
        sessionId: holdRecord.session_id,
        seatIds: heldSeatIds,
        expiresAt: holdRecord.expires_at,
        confirmed: holdRecord.confirmed,
      },
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        error: 'One or more seats are unavailable',
        conflictingSeatIds: err.conflictingSeatIds ?? [],
      });
    }
    if (err.status === 400 && err.missing) {
      return res.status(400).json({ error: 'Unknown seat ids', missing: err.missing });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Failed to create hold' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// ---------------------------------------------------------------------------

router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    let bookingResult = null;
    let expiredSeatIds = [];

    await transaction(async (tx) => {
      // 1. Release expired holds (safety net).
      expiredSeatIds = await releaseExpiredHoldsTx(tx);

      // 2. Fetch the hold.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed, confirmed_at
         FROM   holds
         WHERE  id = $1`,
        [holdId],
      );

      if (holdRows.length === 0) {
        throw Object.assign(new Error('Hold not found'), { status: 404 });
      }

      const hold = holdRows[0];

      // 3. Ownership check.
      if (hold.session_id !== sessionId.trim()) {
        throw Object.assign(new Error('Hold belongs to a different session'), { status: 403 });
      }

      // 4. Idempotency: already confirmed → return existing booking.
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id FROM seats WHERE hold_id = $1`,
          [holdId],
        );
        bookingResult = {
          holdId: hold.id,
          sessionId: hold.session_id,
          seatIds: bookedSeats.map((s) => s.id),
          confirmedAt: hold.confirmed_at,
          alreadyConfirmed: true,
        };
        return; // exit transaction fn – no further writes needed
      }

      // 5. Expiry check (belt-and-suspenders: releaseExpiredHoldsTx already
      //    released this hold's seats if expired, so the held-seats check
      //    below would also catch it, but an explicit message is clearer).
      const { rows: nowRows } = await tx.query(`SELECT NOW() AS now`);
      const now = new Date(nowRows[0].now);
      const expiresAt = new Date(hold.expires_at);
      if (now > expiresAt) {
        throw Object.assign(new Error('Hold has expired'), { status: 410 });
      }

      // 6. Verify the hold still owns its seats.
      const { rows: heldSeats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId],
      );

      if (heldSeats.length === 0) {
        throw Object.assign(new Error('Hold has no held seats (may have expired)'), { status: 410 });
      }

      // 7. Book the seats.
      await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                booked_by       = $1,
                hold_expires_at = NULL
         WHERE  hold_id = $2
           AND  status  = 'held'`,
        [sessionId.trim(), holdId],
      );

      // 8. Mark the hold as confirmed.
      const { rows: updatedHold } = await tx.query(
        `UPDATE holds
         SET    confirmed    = TRUE,
                confirmed_at = NOW()
         WHERE  id = $1
         RETURNING confirmed_at`,
        [holdId],
      );

      bookingResult = {
        holdId: hold.id,
        sessionId: hold.session_id,
        seatIds: heldSeats.map((s) => s.id),
        confirmedAt: updatedHold[0].confirmed_at,
        alreadyConfirmed: false,
      };
    });

    // Broadcast expired seats released during this transaction.
    if (expiredSeatIds.length > 0) {
      broadcast('seats:released', { seatIds: expiredSeatIds });
    }

    // Broadcast only on first confirmation.
    if (bookingResult && !bookingResult.alreadyConfirmed) {
      broadcast('seats:booked', {
        holdId: bookingResult.holdId,
        seatIds: bookingResult.seatIds,
        sessionId: bookingResult.sessionId,
      });
    }

    return res.status(200).json({ booking: bookingResult });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Hold not found' });
    }
    if (err.status === 403) {
      return res.status(403).json({ error: 'Hold belongs to a different session' });
    }
    if (err.status === 410) {
      return res.status(410).json({ error: err.message });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// ---------------------------------------------------------------------------

router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    let releasedSeatIds = [];

    await transaction(async (tx) => {
      // Fetch the hold.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1`,
        [holdId],
      );

      if (holdRows.length === 0) {
        throw Object.assign(new Error('Hold not found'), { status: 404 });
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId.trim()) {
        throw Object.assign(new Error('Hold belongs to a different session'), { status: 403 });
      }

      if (hold.confirmed) {
        throw Object.assign(new Error('Cannot release a confirmed hold'), { status: 409 });
      }

      // Collect seats to release.
      const { rows: seats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId],
      );

      // Release the seats.
      await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'`,
        [holdId],
      );

      releasedSeatIds = seats.map((s) => s.id);
    });

    if (releasedSeatIds.length > 0) {
      broadcast('seats:released', { seatIds: releasedSeatIds });
    }

    return res.status(200).json({ released: true, seatIds: releasedSeatIds });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Hold not found' });
    }
    if (err.status === 403) {
      return res.status(403).json({ error: 'Hold belongs to a different session' });
    }
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Failed to release hold' });
  }
});

export default router;
