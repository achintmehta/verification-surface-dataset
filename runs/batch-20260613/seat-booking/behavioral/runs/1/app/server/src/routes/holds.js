/**
 * Hold and confirmation routes.
 *
 * POST /api/holds
 *   Body: { seatIds: string[], sessionId: string }
 *   Atomically acquires ALL requested seats or none (all-or-nothing).
 *   Returns 409 with conflicting seat ids if any seat is unavailable.
 *
 * POST /api/holds/:holdId/confirm
 *   Idempotently confirms a hold, booking its seats permanently.
 *   Returns 410 if the hold is expired or unknown.
 *
 * DELETE /api/holds/:holdId
 *   Releases a hold early, returning its seats to available.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, sweepExpiredHolds, HOLD_TTL_SECONDS } from '../db.js';
import { broadcast } from '../sse.js';

const router = Router();

/* ─────────────────────────────────────────────
   POST /api/holds
   ───────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = getDb();

  try {
    let holdResult = null;
    let heldSeats = [];
    let preReleasedIds = [];

    await db.transaction(async (tx) => {
      // Build parameterized list for the requested seat ids
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');

      // Lock the requested rows for update so concurrent transactions serialize
      const { rows: lockedSeats } = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
           FROM seats
          WHERE id = ANY(ARRAY[${placeholders}]::text[])
          ORDER BY id
          FOR UPDATE`,
        seatIds
      );

      // Validate all requested seats exist
      if (lockedSeats.length !== seatIds.length) {
        const foundIds = new Set(lockedSeats.map((s) => s.id));
        const missing = seatIds.filter((id) => !foundIds.has(id));
        throw Object.assign(new Error('Unknown seat ids'), {
          status: 400,
          body: { error: 'Unknown seat ids', unknownIds: missing },
        });
      }

      const now = new Date();

      // Separate seats into: genuinely unavailable vs. available (incl. expired holds)
      const unavailable = [];
      const expiredHoldIds = new Set();

      for (const seat of lockedSeats) {
        if (seat.status === 'available') continue;

        if (
          seat.status === 'held' &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at) <= now
        ) {
          // Expired hold – collect the hold id so we can clean it up
          if (seat.hold_id) expiredHoldIds.add(seat.hold_id);
          continue; // treat as available
        }

        // Genuinely unavailable (active hold or booked)
        unavailable.push(seat.id);
      }

      if (unavailable.length > 0) {
        throw Object.assign(new Error('Seats unavailable'), {
          status: 409,
          body: { error: 'Seats unavailable', conflictIds: unavailable },
        });
      }

      // Clean up any expired holds that were blocking these seats
      if (expiredHoldIds.size > 0) {
        const expiredIds = [...expiredHoldIds];
        const expPlaceholders = expiredIds.map((_, i) => `$${i + 1}`).join(', ');

        // Release seats belonging to those expired holds (not just the requested ones)
        const { rows: extraReleased } = await tx.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = ANY(ARRAY[${expPlaceholders}]::text[])
              AND status = 'held'
            RETURNING id`,
          expiredIds
        );
        preReleasedIds = extraReleased.map((s) => s.id);

        await tx.query(
          `DELETE FROM holds
            WHERE id = ANY(ARRAY[${expPlaceholders}]::text[])
              AND confirmed = FALSE`,
          expiredIds
        );
      }

      // All seats are now available – create the new hold
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // Mark the requested seats as held
      await tx.query(
        `UPDATE seats
            SET status = 'held',
                hold_id = $1,
                hold_expires_at = $2
          WHERE id = ANY(ARRAY[${placeholders}]::text[])`,
        [holdId, expiresAt.toISOString(), ...seatIds]
      );

      // Fetch the updated seats to return / broadcast
      const { rows: updatedSeats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
           FROM seats
          WHERE id = ANY(ARRAY[${placeholders}]::text[])`,
        seatIds
      );

      holdResult = { holdId, sessionId, expiresAt: expiresAt.toISOString(), seatIds };
      heldSeats = updatedSeats;
    });

    // Broadcast outside the transaction
    if (preReleasedIds.length > 0) {
      // Broadcast releases for any seats that were freed from expired holds
      // (excluding the ones we just held, which get their own event)
      const notReheld = preReleasedIds.filter((id) => !seatIds.includes(id));
      if (notReheld.length > 0) {
        broadcast('seat-released', notReheld.map((id) => ({ id, status: 'available' })));
      }
    }
    broadcast('seat-held', heldSeats);

    return res.status(201).json(holdResult);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   POST /api/holds/:holdId/confirm
   ───────────────────────────────────────────── */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = getDb();

  try {
    let bookingResult = null;
    let bookedSeats = [];

    await db.transaction(async (tx) => {
      // Lock the hold row
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
           FROM holds
          WHERE id = $1
          FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw Object.assign(new Error('Hold not found'), {
          status: 410,
          body: { error: 'Hold not found or already expired' },
        });
      }

      const hold = holdRows[0];

      // Ownership check
      if (hold.session_id !== sessionId) {
        throw Object.assign(new Error('Forbidden'), {
          status: 403,
          body: { error: 'This hold belongs to a different session' },
        });
      }

      // Idempotency: already confirmed → return the existing booking
      if (hold.confirmed) {
        const { rows: alreadyBooked } = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by
             FROM seats
            WHERE hold_id = $1`,
          [holdId]
        );
        bookingResult = {
          holdId,
          sessionId,
          seatIds: alreadyBooked.map((s) => s.id),
          alreadyConfirmed: true,
        };
        bookedSeats = alreadyBooked;
        return;
      }

      // Expiry check (only for unconfirmed holds)
      if (new Date(hold.expires_at) <= new Date()) {
        throw Object.assign(new Error('Hold expired'), {
          status: 410,
          body: { error: 'Hold has expired' },
        });
      }

      // Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      // Book the seats
      const { rows: seats } = await tx.query(
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
        throw Object.assign(new Error('Seats no longer held'), {
          status: 409,
          body: { error: 'Seats are no longer held by this hold' },
        });
      }

      bookingResult = { holdId, sessionId, seatIds: seats.map((s) => s.id) };
      bookedSeats = seats;
    });

    // Broadcast outside the transaction
    if (!bookingResult.alreadyConfirmed) {
      broadcast('seat-booked', bookedSeats);
    }

    return res.status(200).json(bookingResult);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error('POST /api/holds/:holdId/confirm error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   DELETE /api/holds/:holdId
   ───────────────────────────────────────────── */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  const db = getDb();

  try {
    let releasedSeats = [];

    await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed, expires_at
           FROM holds
          WHERE id = $1
          FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        // Already gone – treat as success (idempotent)
        return;
      }

      const hold = holdRows[0];

      if (sessionId && hold.session_id !== sessionId) {
        throw Object.assign(new Error('Forbidden'), {
          status: 403,
          body: { error: 'This hold belongs to a different session' },
        });
      }

      if (hold.confirmed) {
        throw Object.assign(new Error('Already confirmed'), {
          status: 409,
          body: { error: 'Cannot release a confirmed hold' },
        });
      }

      // Release seats
      const { rows: seats } = await tx.query(
        `UPDATE seats
            SET status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
          WHERE hold_id = $1
            AND status = 'held'
          RETURNING id`,
        [holdId]
      );

      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      releasedSeats = seats;
    });

    if (releasedSeats.length > 0) {
      broadcast('seat-released', releasedSeats.map((s) => ({ id: s.id, status: 'available' })));
    }

    return res.status(200).json({ released: releasedSeats.map((s) => s.id) });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error('DELETE /api/holds/:holdId error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
