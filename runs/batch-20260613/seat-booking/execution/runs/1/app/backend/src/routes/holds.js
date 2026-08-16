/**
 * routes/holds.js
 *
 * POST /api/holds            – create a hold (all-or-nothing)
 * POST /api/holds/:id/confirm – confirm a hold (idempotent)
 * DELETE /api/holds/:id       – release a hold early
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Concurrency guarantee
 * ─────────────────────────────────────────────────────────────────────────────
 * PGLite serialises all queries through a single async queue, which means
 * every `db.transaction()` block runs atomically with respect to every other
 * query.  We exploit this by:
 *
 *  1. Running a conditional UPDATE that only touches seats that are currently
 *     'available' (or whose hold has expired).
 *  2. Checking that the number of updated rows equals the number of requested
 *     seats.  If it does not, we roll back and return 409 with the conflicting
 *     seat ids.
 *
 * This is equivalent to a SELECT … FOR UPDATE / check / UPDATE pattern but
 * works within PGLite's single-connection model.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

export const holdsRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/holds
// ─────────────────────────────────────────────────────────────────────────────
holdsRouter.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array.' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  // Deduplicate seat ids.
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    // Lazy expiry before we attempt to acquire seats.
    await releaseExpiredHolds();

    const db = await getDb();

    let holdRecord = null;
    let heldSeats = [];
    let conflictIds = [];

    await db.transaction(async (tx) => {
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      // ── Step 1: Insert the hold record ────────────────────────────────────
      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // ── Step 2: Atomically acquire all requested seats ────────────────────
      // Only update seats that are currently 'available'.  Expired-but-not-yet-
      // swept seats are also treated as available (hold_expires_at < NOW()).
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 3}`).join(', ');

      const { rows: updated } = await tx.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = $2
         WHERE  id IN (${placeholders})
           AND  (
                  status = 'available'
                  OR (status = 'held' AND hold_expires_at < NOW())
                )
         RETURNING id`,
        [holdId, expiresAt.toISOString(), ...uniqueSeatIds]
      );

      const acquiredIds = updated.map((r) => r.id);

      // ── Step 3: Check all-or-nothing ──────────────────────────────────────
      if (acquiredIds.length !== uniqueSeatIds.length) {
        // Some seats were unavailable – find which ones.
        conflictIds = uniqueSeatIds.filter((id) => !acquiredIds.includes(id));

        // Roll back by throwing; the transaction wrapper will abort.
        throw new ConflictError(conflictIds);
      }

      // ── Step 4: Collect the full seat rows for the response ───────────────
      const seatPlaceholders = acquiredIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await tx.query(
        `SELECT id, row_label AS "rowLabel", seat_number AS "seatNumber",
                status, hold_id AS "holdId",
                hold_expires_at AS "holdExpiresAt", booked_by AS "bookedBy"
         FROM   seats
         WHERE  id IN (${seatPlaceholders})`,
        acquiredIds
      );

      holdRecord = {
        id: holdId,
        sessionId,
        expiresAt: expiresAt.toISOString(),
        seats,
      };
      heldSeats = seats;
    });

    // ── Broadcast outside the transaction ─────────────────────────────────
    broadcast(
      heldSeats.map((s) => ({
        id: s.id,
        status: 'held',
        holdId: s.holdId,
        holdExpiresAt: s.holdExpiresAt,
        bookedBy: null,
      }))
    );

    return res.status(201).json(holdRecord);
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({
        error: 'One or more seats are unavailable.',
        conflictSeatIds: err.conflictIds,
      });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/holds/:holdId/confirm
// ─────────────────────────────────────────────────────────────────────────────
holdsRouter.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    // Lazy expiry before confirming.
    await releaseExpiredHolds();

    const db = await getDb();

    let bookingResult = null;
    let newlyBooked = false;

    await db.transaction(async (tx) => {
      // ── Step 1: Fetch the hold ────────────────────────────────────────────
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id AS "sessionId", expires_at AS "expiresAt",
                confirmed
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw new NotFoundError('Hold not found or has expired.');
      }

      const hold = holdRows[0];

      // ── Step 2: Ownership check ───────────────────────────────────────────
      if (hold.sessionId !== sessionId) {
        throw new ForbiddenError('This hold belongs to a different session.');
      }

      // ── Step 3: Expiry check ──────────────────────────────────────────────
      if (new Date(hold.expiresAt) < new Date()) {
        throw new GoneError('Hold has expired.');
      }

      // ── Step 4: Idempotency – already confirmed ───────────────────────────
      if (hold.confirmed) {
        // Return the already-booked seats without doing anything else.
        const { rows: seats } = await tx.query(
          `SELECT id, row_label AS "rowLabel", seat_number AS "seatNumber",
                  status, hold_id AS "holdId",
                  hold_expires_at AS "holdExpiresAt", booked_by AS "bookedBy"
           FROM   seats
           WHERE  hold_id = $1`,
          [holdId]
        );
        bookingResult = { holdId, sessionId, seats, alreadyConfirmed: true };
        return; // exit transaction callback – no writes needed
      }

      // ── Step 5: Book the seats ────────────────────────────────────────────
      const { rows: bookedSeats } = await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                booked_by       = $1,
                hold_expires_at = NULL
         WHERE  hold_id = $2
           AND  status  = 'held'
         RETURNING id, row_label AS "rowLabel", seat_number AS "seatNumber",
                   status, hold_id AS "holdId",
                   hold_expires_at AS "holdExpiresAt", booked_by AS "bookedBy"`,
        [sessionId, holdId]
      );

      if (bookedSeats.length === 0) {
        // The seats were released between the expiry check and now (extremely
        // unlikely with PGLite's serial queue, but be safe).
        throw new GoneError('Hold seats are no longer available.');
      }

      // ── Step 6: Mark hold as confirmed ───────────────────────────────────
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      bookingResult = { holdId, sessionId, seats: bookedSeats };
      newlyBooked = true;
    });

    // ── Broadcast outside the transaction ─────────────────────────────────
    if (newlyBooked && bookingResult.seats.length > 0) {
      broadcast(
        bookingResult.seats.map((s) => ({
          id: s.id,
          status: 'booked',
          holdId: s.holdId,
          holdExpiresAt: null,
          bookedBy: s.bookedBy,
        }))
      );
    }

    return res.json(bookingResult);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ForbiddenError) {
      return res.status(403).json({ error: err.message });
    }
    if (err instanceof GoneError) {
      return res.status(410).json({ error: err.message });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/holds/:holdId
// ─────────────────────────────────────────────────────────────────────────────
holdsRouter.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    const db = await getDb();

    let releasedSeatIds = [];

    await db.transaction(async (tx) => {
      // Verify the hold exists and belongs to this session.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id AS "sessionId", confirmed
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        // Already gone – treat as success (idempotent delete).
        return;
      }

      const hold = holdRows[0];

      if (hold.sessionId !== sessionId) {
        throw new ForbiddenError('This hold belongs to a different session.');
      }

      if (hold.confirmed) {
        throw new ConflictError([], 'Cannot release a confirmed hold.');
      }

      // Release the seats.
      const { rows: released } = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'
         RETURNING id`,
        [holdId]
      );

      releasedSeatIds = released.map((r) => r.id);

      // Remove the hold record.
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);
    });

    // Broadcast outside the transaction.
    if (releasedSeatIds.length > 0) {
      broadcast(
        releasedSeatIds.map((id) => ({
          id,
          status: 'available',
          holdId: null,
          holdExpiresAt: null,
          bookedBy: null,
        }))
      );
    }

    return res.json({ released: releasedSeatIds });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return res.status(403).json({ error: err.message });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom error types
// ─────────────────────────────────────────────────────────────────────────────
class ConflictError extends Error {
  constructor(conflictIds, message = 'Conflict') {
    super(message);
    this.conflictIds = conflictIds;
  }
}

class NotFoundError extends Error {}
class ForbiddenError extends Error {}
class GoneError extends Error {}
