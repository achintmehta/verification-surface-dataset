/**
 * Holds routes:
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/** Build a comma-separated list of $N placeholders starting at `offset` (1-based). */
function placeholderList(count, offset = 1) {
  return Array.from({ length: count }, (_, i) => `$${i + offset}`).join(', ');
}

/* ─────────────────────────────────────────────────────────────
   POST /api/holds
   Body: { seatIds: string[], sessionId: string }
   ───────────────────────────────────────────────────────────── */
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
    // Release expired holds first so we have accurate availability
    await releaseExpiredHolds();

    // Deduplicate requested seat ids
    const uniqueSeatIds = [...new Set(seatIds)];

    const result = await db.transaction(async (tx) => {
      // Lock the requested seats FOR UPDATE to prevent concurrent modifications.
      // Parameters: $1..$N = seat ids
      const selectPlaceholders = placeholderList(uniqueSeatIds.length, 1);
      const { rows: lockedSeats } = await tx.query(
        `SELECT id, status, hold_expires_at
         FROM seats
         WHERE id IN (${selectPlaceholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      // Verify all requested seats exist
      if (lockedSeats.length !== uniqueSeatIds.length) {
        const foundIds = new Set(lockedSeats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', seatIds: missing };
      }

      const now = Date.now();

      // Find unavailable seats (held-and-not-expired, or booked)
      const conflicting = lockedSeats.filter((seat) => {
        if (seat.status === 'booked') return true;
        if (seat.status === 'held') {
          // Treat as available if expired
          if (seat.hold_expires_at && new Date(seat.hold_expires_at).getTime() < now) {
            return false;
          }
          return true;
        }
        return false;
      });

      if (conflicting.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are unavailable',
          conflictingSeatIds: conflicting.map((s) => s.id),
        };
      }

      // All seats are available – create the hold
      const holdId = randomUUID();
      const expiresAt = new Date(now + HOLD_TTL_SECONDS * 1000);

      // $1=holdId, $2=sessionId, $3=expiresAt
      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, $3::timestamptz)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // Mark each seat as held.
      // $1=holdId, $2=expiresAt, $3..$N+2 = seat ids
      const updatePlaceholders = placeholderList(uniqueSeatIds.length, 3);
      await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $1,
             hold_expires_at = $2::timestamptz
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt.toISOString(), ...uniqueSeatIds]
      );

      return { holdId, expiresAt, seatIds: uniqueSeatIds };
    });

    // Broadcast seat transitions
    for (const seatId of result.seatIds) {
      broadcast('seat:held', {
        seatId,
        status: 'held',
        holdId: result.holdId,
        expiresAt: result.expiresAt.toISOString(),
        sessionId,
      });
    }

    return res.status(201).json({
      holdId: result.holdId,
      seatIds: result.seatIds,
      sessionId,
      expiresAt: result.expiresAt.toISOString(),
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.error,
        conflictingSeatIds: err.conflictingSeatIds,
        seatIds: err.seatIds,
      });
    }
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/holds/:holdId/confirm
   Body: { sessionId: string }
   ───────────────────────────────────────────────────────────── */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = getDb();

  try {
    // Release expired holds first
    await releaseExpiredHolds();

    const result = await db.transaction(async (tx) => {
      // Lock the hold row
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed, released
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      // Ownership check
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold does not belong to this session' };
      }

      // Idempotency: already confirmed → return existing booking
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM seats
           WHERE booked_by = $1`,
          [holdId]
        );
        return { alreadyConfirmed: true, seats: bookedSeats, holdId };
      }

      // Released (expired or manually released) → reject
      if (hold.released) {
        throw { status: 410, error: 'Hold has been released and can no longer be confirmed' };
      }

      // Expiry check
      const now = Date.now();
      if (new Date(hold.expires_at).getTime() < now) {
        throw { status: 410, error: 'Hold has expired' };
      }

      // Verify the seats still belong to this hold and lock them
      const { rows: heldSeats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
         WHERE hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        throw { status: 410, error: 'No seats found for this hold' };
      }

      const wrongState = heldSeats.filter((s) => s.status !== 'held');
      if (wrongState.length > 0) {
        throw {
          status: 409,
          error: 'Some seats are no longer in held state',
          seats: wrongState.map((s) => s.id),
        };
      }

      // Book the seats: $1=holdId (used as booked_by), $2=holdId (WHERE clause)
      await tx.query(
        `UPDATE seats
         SET status = 'booked',
             hold_id = NULL,
             hold_expires_at = NULL,
             booked_by = $1
         WHERE hold_id = $2`,
        [holdId, holdId]
      );

      // Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      const { rows: bookedSeats } = await tx.query(
        `SELECT id, row_label, seat_number, status, booked_by
         FROM seats
         WHERE booked_by = $1`,
        [holdId]
      );

      return { alreadyConfirmed: false, seats: bookedSeats, holdId };
    });

    // Broadcast only on first confirmation
    if (!result.alreadyConfirmed) {
      for (const seat of result.seats) {
        broadcast('seat:booked', {
          seatId: seat.id,
          status: 'booked',
          holdId,
          sessionId,
        });
      }
    }

    return res.status(200).json({
      holdId,
      sessionId,
      seats: result.seats,
      alreadyConfirmed: result.alreadyConfirmed,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, seats: err.seats });
    }
    console.error(`POST /api/holds/${holdId}/confirm error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/holds/:holdId
   Body: { sessionId: string }
   ───────────────────────────────────────────────────────────── */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = getDb();

  try {
    const releasedSeatIds = await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed, released
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold does not belong to this session' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release a confirmed hold' };
      }

      if (hold.released) {
        // Already released – idempotent success
        return [];
      }

      // Release the seats
      const { rows: seats } = await tx.query(
        `UPDATE seats
         SET status = 'available',
             hold_id = NULL,
             hold_expires_at = NULL
         WHERE hold_id = $1
         RETURNING id`,
        [holdId]
      );

      await tx.query(
        `UPDATE holds SET released = TRUE WHERE id = $1`,
        [holdId]
      );

      return seats.map((s) => s.id);
    });

    // Broadcast releases
    for (const seatId of releasedSeatIds) {
      broadcast('seat:released', { seatId, status: 'available', holdId });
    }

    return res.status(200).json({ holdId, releasedSeatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error(`DELETE /api/holds/${holdId} error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
