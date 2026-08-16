import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// POST /api/holds
// Body: { seatIds: string[], sessionId: string }
// Atomically acquires ALL requested seats or none (all-or-nothing).
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
  const uniqueIds = [...new Set(seatIds)];

  try {
    const db = await getDb();

    // Release expired holds first (may free up seats)
    await releaseExpiredHolds(db);

    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // --- Atomic all-or-nothing acquisition ---
    // We use a single UPDATE with a WHERE clause that only matches available seats.
    // Then we check how many rows were updated vs requested.
    // If the counts differ, some seats were unavailable → roll back by resetting
    // the ones we just updated.
    //
    // PGLite does not expose BEGIN/COMMIT as separate calls on the same connection
    // in a straightforward way through the query API, but we can use db.transaction().

    let conflictingIds = [];
    let updatedSeats = [];

    await db.transaction(async (tx) => {
      // Lock and inspect the requested seats
      const idList = uniqueIds.map((id) => `'${id}'`).join(', ');

      const current = await tx.query(`
        SELECT id, status, hold_expires_at
        FROM   seats
        WHERE  id IN (${idList})
        FOR UPDATE
      `);

      // Validate all requested seats exist
      if (current.rows.length !== uniqueIds.length) {
        const foundIds = new Set(current.rows.map((r) => r.id));
        const missing = uniqueIds.filter((id) => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', details: missing };
      }

      // Determine which seats are truly available (expired holds count as available)
      const now = new Date();
      conflictingIds = current.rows
        .filter((r) => {
          if (r.status === 'available') return false;
          if (r.status === 'held' && r.hold_expires_at && new Date(r.hold_expires_at) <= now) {
            return false; // effectively available
          }
          return true; // held (active) or booked
        })
        .map((r) => r.id);

      if (conflictingIds.length > 0) {
        throw { status: 409, error: 'Seats unavailable', conflictingIds };
      }

      // Insert the hold record
      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, sessionId, expiresAt]
      );

      // Mark all requested seats as held
      await tx.query(`
        UPDATE seats
        SET    status = 'held',
               hold_id = $1,
               hold_expires_at = $2
        WHERE  id IN (${idList})
      `, [holdId, expiresAt]);

      // Fetch updated seat rows for broadcast
      const updated = await tx.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM   seats
        WHERE  id IN (${idList})
      `);
      updatedSeats = updated.rows;
    });

    // Broadcast seat updates to all SSE clients
    broadcast('seats:updated', updatedSeats);

    return res.status(201).json({
      holdId,
      sessionId,
      seatIds: uniqueIds,
      expiresAt,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.error,
        conflictingIds: err.conflictingIds,
        details: err.details,
      });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// Idempotent: confirming an already-confirmed hold returns the same result.
// ---------------------------------------------------------------------------
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    // Release expired holds first
    await releaseExpiredHolds(db);

    let bookedSeats = [];

    await db.transaction(async (tx) => {
      // Fetch the hold record (lock it)
      const holdResult = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdResult.rows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      // Idempotency: already confirmed → return current booked seats
      if (hold.confirmed) {
        const seats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId]
        );
        bookedSeats = seats.rows;
        // Signal idempotent path
        throw { idempotent: true, seats: bookedSeats };
      }

      // Check expiry
      if (new Date(hold.expires_at) <= new Date()) {
        throw { status: 410, error: 'Hold has expired' };
      }

      // Verify the hold still owns its seats (they haven't been released by expiry sweep)
      const ownedSeats = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM   seats
         WHERE  hold_id = $1
           AND  status = 'held'
         FOR UPDATE`,
        [holdId]
      );

      if (ownedSeats.rows.length === 0) {
        throw { status: 410, error: 'Hold seats are no longer held (expired or released)' };
      }

      // Book the seats
      await tx.query(
        `UPDATE seats
         SET    status = 'booked',
                hold_id = NULL,
                hold_expires_at = NULL,
                booked_by = $1
         WHERE  hold_id = $2
           AND  status = 'held'`,
        [holdId, holdId]
      );

      // Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      // Fetch the now-booked seats
      const updated = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM   seats
         WHERE  booked_by = $1`,
        [holdId]
      );
      bookedSeats = updated.rows;
    });

    // Broadcast
    broadcast('seats:updated', bookedSeats);

    return res.json({
      holdId,
      sessionId,
      booked: bookedSeats.map((s) => s.id),
      seats: bookedSeats,
    });
  } catch (err) {
    if (err.idempotent) {
      // Already confirmed – return 200 with existing booking
      return res.json({
        holdId,
        sessionId,
        booked: err.seats.map((s) => s.id),
        seats: err.seats,
        idempotent: true,
      });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
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
    let releasedSeats = [];

    await db.transaction(async (tx) => {
      const holdResult = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdResult.rows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release a confirmed (booked) hold' };
      }

      // Release the seats
      const updated = await tx.query(
        `UPDATE seats
         SET    status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId]
      );
      releasedSeats = updated.rows;

      // Delete the hold record
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);
    });

    broadcast('seats:updated', releasedSeats);

    return res.json({ released: releasedSeats.map((s) => s.id), seats: releasedSeats });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { HOLD_TTL_SECONDS };
export default router;
