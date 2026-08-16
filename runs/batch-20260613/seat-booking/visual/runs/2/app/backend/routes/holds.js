import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcastSeats } from '../sse.js';

const router = Router();

const HOLD_TTL_SECONDS = 60; // 60-second hold TTL

/**
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently
 * available. On success, creates a hold and returns it. If any seat is
 * unavailable, acquires none and returns 409 with conflicting seat ids.
 */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    await db.query('BEGIN');

    // Release expired holds first (inside the transaction)
    await releaseExpiredHolds(db);

    // Lock the requested seats FOR UPDATE to prevent concurrent modifications
    // Sort to avoid deadlocks
    const sortedIds = [...seatIds].sort();
    const placeholders = sortedIds.map((_, i) => `$${i + 1}`).join(', ');

    const lockResult = await db.query(
      `SELECT id, status,
              CASE WHEN status = 'held' AND hold_expires_at >= NOW() THEN true ELSE false END AS hold_active
       FROM seats
       WHERE id IN (${placeholders})
       ORDER BY id
       FOR UPDATE`,
      sortedIds
    );

    // Check that all requested seats exist
    if (lockResult.rows.length !== sortedIds.length) {
      await db.query('ROLLBACK');
      const foundIds = new Set(lockResult.rows.map(r => r.id));
      const missing = sortedIds.filter(id => !foundIds.has(id));
      return res.status(400).json({ error: 'Unknown seat ids', missing });
    }

    // Check for unavailable seats
    // A seat is unavailable if it's booked, or held with an active (non-expired) hold
    const unavailable = lockResult.rows.filter(seat => {
      if (seat.status === 'booked') return true;
      if (seat.status === 'held' && seat.hold_active) return true;
      return false;
    });

    if (unavailable.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({
        error: 'Some seats are unavailable',
        conflictingSeatIds: unavailable.map(s => s.id),
      });
    }

    // All seats are available — create the hold
    const holdId = uuidv4();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at, confirmed)
       VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval, FALSE)`,
      [holdId, sessionId, HOLD_TTL_SECONDS.toString()]
    );

    // Mark all seats as held
    // placeholders are $1..$N for sortedIds; holdId is $(N+1), TTL is $(N+2)
    const holdIdParam = sortedIds.length + 1;
    const ttlParam = sortedIds.length + 2;
    await db.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $${holdIdParam},
           hold_expires_at = NOW() + ($${ttlParam} || ' seconds')::interval
       WHERE id IN (${placeholders})`,
      [...sortedIds, holdId, HOLD_TTL_SECONDS.toString()]
    );

    // Fetch the actual expires_at from the DB
    const holdRow = await db.query(
      `SELECT id, session_id, expires_at FROM holds WHERE id = $1`,
      [holdId]
    );

    await db.query('COMMIT');

    const expiresAt = holdRow.rows[0].expires_at;

    // Broadcast the hold to all SSE clients
    broadcastSeats(
      sortedIds.map(id => ({
        id,
        status: 'held',
        holdId,
        expiresAt,
      })),
      'seat_held'
    );

    return res.status(201).json({
      hold: {
        id: holdId,
        sessionId,
        seatIds: sortedIds,
        expiresAt,
      },
    });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/holds/:holdId/confirm
 * Idempotently confirms a hold, booking its seats permanently.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    await db.query('BEGIN');

    // Fetch and lock the hold
    const holdResult = await db.query(
      `SELECT id, session_id, expires_at, confirmed,
              (expires_at < NOW()) AS is_expired
       FROM holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const hold = holdResult.rows[0];

    // Verify ownership
    if (hold.session_id !== sessionId) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Hold does not belong to this session' });
    }

    // Idempotency: if already confirmed, return the existing booking
    if (hold.confirmed) {
      const bookedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, booked_by
         FROM seats
         WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('ROLLBACK');
      return res.status(200).json({
        message: 'Already confirmed',
        booking: {
          holdId,
          sessionId,
          seats: bookedSeats.rows,
        },
      });
    }

    // Check expiry (using DB-computed flag)
    if (hold.is_expired) {
      await db.query('ROLLBACK');
      return res.status(410).json({ error: 'Hold has expired' });
    }

    // Verify the hold still owns its seats (they must be in 'held' status with this holdId)
    const seatsResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id
       FROM seats
       WHERE hold_id = $1
       FOR UPDATE`,
      [holdId]
    );

    const seats = seatsResult.rows;

    if (seats.length === 0) {
      await db.query('ROLLBACK');
      return res.status(410).json({ error: 'Hold has no associated seats (may have expired)' });
    }

    // Ensure all seats are still held by this hold
    const invalidSeats = seats.filter(s => s.status !== 'held' || s.hold_id !== holdId);
    if (invalidSeats.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({
        error: 'Some seats are no longer held by this hold',
        invalidSeatIds: invalidSeats.map(s => s.id),
      });
    }

    // Book the seats
    await db.query(
      `UPDATE seats
       SET status = 'booked',
           hold_expires_at = NULL,
           booked_by = $1
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    // Mark hold as confirmed
    await db.query(
      `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
      [holdId]
    );

    await db.query('COMMIT');

    // Broadcast booking
    broadcastSeats(
      seats.map(s => ({
        id: s.id,
        status: 'booked',
        bookedBy: sessionId,
      })),
      'seat_booked'
    );

    return res.status(200).json({
      booking: {
        holdId,
        sessionId,
        seats: seats.map(s => ({ id: s.id, row_label: s.row_label, seat_number: s.seat_number })),
      },
    });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/holds/:holdId
 * Releases a hold early, returning its seats to available.
 */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    await db.query('BEGIN');

    const holdResult = await db.query(
      `SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const hold = holdResult.rows[0];

    if (hold.session_id !== sessionId) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Hold does not belong to this session' });
    }

    if (hold.confirmed) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot release a confirmed hold' });
    }

    // Release the seats
    const seatsResult = await db.query(
      `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id`,
      [holdId]
    );

    // Delete the hold
    await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

    await db.query('COMMIT');

    const releasedIds = seatsResult.rows.map(r => r.id);

    // Broadcast releases
    if (releasedIds.length > 0) {
      broadcastSeats(
        releasedIds.map(id => ({ id, status: 'available' })),
        'seat_released'
      );
    }

    return res.status(200).json({ released: releasedIds });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
