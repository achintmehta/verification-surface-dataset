/**
 * Holds routes
 *
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 */

import { Router }     from 'express';
import { randomUUID } from 'crypto';
import { getDb }      from '../db.js';
import { sweepExpiredHolds, broadcastReleases } from '../expiry.js';
import { broadcast }  from '../sse.js';
import { seatMutex }  from '../mutex.js';

const router = Router();

// Hold TTL in seconds (configurable via env).
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS ?? '60', 10);

// ── POST /api/holds ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate requested seat ids.
  const uniqueSeatIds = [...new Set(seatIds)];

  const release = await seatMutex.acquire();
  try {
    const db = await getDb();

    let hold;
    let conflicting = [];
    let released    = [];

    await db.transaction(async (tx) => {
      // 1. Sweep expired holds first so we don't block on stale data.
      released = await sweepExpiredHolds(tx);

      // 2. Read the requested seats.
      //    Sort ids for consistent ordering (good practice even with mutex).
      const sorted = [...uniqueSeatIds].sort();
      const { rows: lockedSeats } = await tx.query(`
        SELECT id, status, hold_expires_at
        FROM   seats
        WHERE  id = ANY($1)
        ORDER  BY id
      `, [sorted]);

      // 3. Verify all requested seats exist.
      if (lockedSeats.length !== uniqueSeatIds.length) {
        const found   = new Set(lockedSeats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !found.has(id));
        throw Object.assign(new Error('Unknown seat ids'), { status: 400, missing });
      }

      // 4. Find seats that are NOT available (after expiry check).
      conflicting = lockedSeats
        .filter((s) => {
          if (s.status === 'available') return false;
          if (s.status === 'held') {
            // Treat expired holds as available (sweep should have caught them,
            // but be defensive).
            if (s.hold_expires_at && new Date(s.hold_expires_at) <= new Date()) {
              return false;
            }
          }
          return true; // held (active) or booked
        })
        .map((s) => s.id);

      if (conflicting.length > 0) {
        // All-or-nothing: do not acquire any seat.
        throw Object.assign(new Error('Seats unavailable'), {
          status: 409,
          conflicting,
        });
      }

      // 5. Create the hold record.
      const holdId    = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(`
        INSERT INTO holds (id, session_id, expires_at)
        VALUES ($1, $2, $3)
      `, [holdId, sessionId, expiresAt.toISOString()]);

      // 6. Mark every requested seat as held.
      //    Use a conditional UPDATE to guard against any race (belt-and-suspenders).
      const { rows: updatedSeats } = await tx.query(`
        UPDATE seats
        SET    status          = 'held',
               hold_id         = $1,
               hold_expires_at = $2
        WHERE  id = ANY($3)
          AND  (status = 'available'
                OR (status = 'held' AND hold_expires_at <= NOW()))
        RETURNING id
      `, [holdId, expiresAt.toISOString(), uniqueSeatIds]);

      // If we couldn't update all seats, something slipped through.
      if (updatedSeats.length !== uniqueSeatIds.length) {
        const updated    = new Set(updatedSeats.map((s) => s.id));
        const stillTaken = uniqueSeatIds.filter((id) => !updated.has(id));
        throw Object.assign(new Error('Seats unavailable'), {
          status: 409,
          conflicting: stillTaken,
        });
      }

      hold = {
        id:        holdId,
        sessionId,
        seatIds:   uniqueSeatIds,
        expiresAt: expiresAt.toISOString(),
      };
    });

    // Broadcast outside the transaction (but still inside the mutex so
    // ordering is preserved).
    broadcastReleases(released);
    broadcast('seats_held', {
      holdId:    hold.id,
      sessionId: hold.sessionId,
      seatIds:   hold.seatIds,
      expiresAt: hold.expiresAt,
    });

    return res.status(201).json(hold);
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        error:       'One or more seats are unavailable',
        conflicting: err.conflicting,
      });
    }
    if (err.status === 400 && err.missing) {
      return res.status(400).json({
        error:   'Unknown seat ids',
        missing: err.missing,
      });
    }
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    release();
  }
});

// ── POST /api/holds/:holdId/confirm ────────────────────────────────────────
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId }   = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const release = await seatMutex.acquire();
  try {
    const db = await getDb();

    let booking;
    let released = [];

    await db.transaction(async (tx) => {
      // 1. Sweep expired holds.
      released = await sweepExpiredHolds(tx);

      // 2. Fetch the hold.
      const { rows: holdRows } = await tx.query(`
        SELECT id, session_id, expires_at, confirmed
        FROM   holds
        WHERE  id = $1
      `, [holdId]);

      // ── Idempotency: already confirmed ──────────────────────────────────
      if (holdRows.length > 0 && holdRows[0].confirmed) {
        // Return the existing booking info.
        const { rows: bookedSeats } = await tx.query(`
          SELECT id FROM seats WHERE booked_by = $1
        `, [holdId]);

        booking = {
          holdId,
          sessionId:        holdRows[0].session_id,
          seatIds:          bookedSeats.map((s) => s.id),
          alreadyConfirmed: true,
        };
        return; // exit transaction callback – no further writes needed
      }

      // ── Hold not found or expired ────────────────────────────────────────
      if (holdRows.length === 0) {
        throw Object.assign(new Error('Hold not found or expired'), { status: 404 });
      }

      const holdRow = holdRows[0];

      // Ownership check.
      if (holdRow.session_id !== sessionId) {
        throw Object.assign(new Error('Hold belongs to a different session'), { status: 403 });
      }

      // Expiry check.
      if (new Date(holdRow.expires_at) <= new Date()) {
        throw Object.assign(new Error('Hold has expired'), { status: 410 });
      }

      // 3. Fetch the seats owned by this hold.
      const { rows: heldSeats } = await tx.query(`
        SELECT id, status, hold_id
        FROM   seats
        WHERE  hold_id = $1
        ORDER  BY id
      `, [holdId]);

      if (heldSeats.length === 0) {
        throw Object.assign(new Error('No seats found for this hold'), { status: 404 });
      }

      // Verify every seat is still held by this hold (defensive).
      const wrongSeats = heldSeats.filter(
        (s) => s.status !== 'held' || s.hold_id !== holdId
      );
      if (wrongSeats.length > 0) {
        throw Object.assign(new Error('Seat state inconsistency'), { status: 409 });
      }

      const seatIds = heldSeats.map((s) => s.id);

      // 4. Book the seats atomically.
      await tx.query(`
        UPDATE seats
        SET    status          = 'booked',
               hold_id         = NULL,
               hold_expires_at = NULL,
               booked_by       = $1
        WHERE  id = ANY($2)
          AND  hold_id = $1
          AND  status  = 'held'
      `, [holdId, seatIds]);

      // 5. Mark the hold as confirmed.
      await tx.query(`
        UPDATE holds
        SET    confirmed = TRUE
        WHERE  id = $1
      `, [holdId]);

      booking = {
        holdId,
        sessionId,
        seatIds,
        alreadyConfirmed: false,
      };
    });

    // Broadcast outside the transaction.
    broadcastReleases(released);
    if (!booking.alreadyConfirmed) {
      broadcast('seats_booked', {
        holdId:    booking.holdId,
        sessionId: booking.sessionId,
        seatIds:   booking.seatIds,
      });
    }

    return res.status(200).json(booking);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err.status === 403) {
      return res.status(403).json({ error: err.message });
    }
    if (err.status === 410) {
      return res.status(410).json({ error: err.message });
    }
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error('POST /api/holds/:holdId/confirm error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    release();
  }
});

// ── DELETE /api/holds/:holdId ──────────────────────────────────────────────
router.delete('/:holdId', async (req, res) => {
  const { holdId }   = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const release = await seatMutex.acquire();
  try {
    const db = await getDb();

    let releasedSeatIds = [];
    let released        = [];

    await db.transaction(async (tx) => {
      released = await sweepExpiredHolds(tx);

      // Fetch the hold.
      const { rows: holdRows } = await tx.query(`
        SELECT id, session_id, confirmed
        FROM   holds
        WHERE  id = $1
      `, [holdId]);

      if (holdRows.length === 0) {
        throw Object.assign(new Error('Hold not found'), { status: 404 });
      }

      const holdRow = holdRows[0];

      if (holdRow.session_id !== sessionId) {
        throw Object.assign(new Error('Hold belongs to a different session'), { status: 403 });
      }

      if (holdRow.confirmed) {
        throw Object.assign(new Error('Cannot release a confirmed hold'), { status: 409 });
      }

      // Release the seats.
      const { rows: seats } = await tx.query(`
        UPDATE seats
        SET    status          = 'available',
               hold_id         = NULL,
               hold_expires_at = NULL
        WHERE  hold_id = $1
        RETURNING id
      `, [holdId]);

      releasedSeatIds = seats.map((s) => s.id);

      // Delete the hold record.
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);
    });

    broadcastReleases(released);
    if (releasedSeatIds.length > 0) {
      broadcast('seats_released', { seatIds: releasedSeatIds, holdId });
    }

    return res.status(200).json({ released: releasedSeatIds });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err.status === 403) {
      return res.status(403).json({ error: err.message });
    }
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error('DELETE /api/holds/:holdId error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    release();
  }
});

export default router;
