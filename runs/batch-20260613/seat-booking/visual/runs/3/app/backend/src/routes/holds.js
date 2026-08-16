import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, sweepExpiredHolds } from '../db.js';
import { broadcastSeatUpdate } from '../sse.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

/**
 * POST /api/holds
 * Body: { seatIds: string[], sessionId: string }
 *
 * Atomically acquires ALL requested seats only if every one is currently available.
 * On success: creates a hold, marks seats as held, returns hold info.
 * On conflict: acquires NONE, returns 409 with conflicting seat ids.
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
    // Use a transaction for atomicity
    const result = await db.transaction(async (tx) => {
      // First sweep expired holds within the transaction
      // We do this by updating seats directly
      await tx.exec(`
        UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at < NOW()
      `);

      // Lock and check all requested seats
      const seatIdList = seatIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');

      const { rows: seatRows } = await tx.query(`
        SELECT id, status, hold_id, hold_expires_at
        FROM seats
        WHERE id IN (${seatIdList})
        ORDER BY id
      `);

      // Verify all requested seats exist
      if (seatRows.length !== seatIds.length) {
        const foundIds = new Set(seatRows.map(r => r.id));
        const missing = seatIds.filter(id => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', missing };
      }

      // Check for unavailable seats
      const unavailable = seatRows.filter(r => r.status !== 'available');
      if (unavailable.length > 0) {
        throw {
          status: 409,
          error: 'One or more seats are not available',
          conflictingSeatIds: unavailable.map(r => r.id)
        };
      }

      // All seats are available — create the hold
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await tx.exec(`
        INSERT INTO holds (id, session_id, expires_at, confirmed, released)
        VALUES ('${holdId}', '${sessionId.replace(/'/g, "''")}', '${expiresAt}', FALSE, FALSE)
      `);

      // Mark all seats as held
      await tx.exec(`
        UPDATE seats
        SET status = 'held',
            hold_id = '${holdId}',
            hold_expires_at = '${expiresAt}'
        WHERE id IN (${seatIdList})
          AND status = 'available'
      `);

      // Verify we actually updated all seats (race condition check)
      const { rows: updatedRows } = await tx.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE id IN (${seatIdList})
      `);

      const notHeld = updatedRows.filter(r => r.hold_id !== holdId);
      if (notHeld.length > 0) {
        throw {
          status: 409,
          error: 'Race condition: some seats were taken concurrently',
          conflictingSeatIds: notHeld.map(r => r.id)
        };
      }

      return { holdId, expiresAt, seatIds, sessionId };
    });

    // Broadcast held event
    broadcastSeatUpdate('held', result.seatIds.map(id => ({
      id,
      status: 'held',
      holdId: result.holdId,
      expiresAt: result.expiresAt
    })));

    res.status(201).json({
      hold: {
        id: result.holdId,
        sessionId: result.sessionId,
        seatIds: result.seatIds,
        expiresAt: result.expiresAt,
        ttlSeconds: HOLD_TTL_SECONDS
      }
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.error,
        conflictingSeatIds: err.conflictingSeatIds,
        missing: err.missing
      });
    }
    console.error('[POST /api/holds]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/holds/:holdId/confirm
 * Confirms a hold, booking all its seats permanently.
 * Idempotent: confirming an already-confirmed hold returns the same result.
 * Rejects expired or unknown holds.
 */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // Fetch the hold
      const { rows: holdRows } = await tx.query(`
        SELECT id, session_id, expires_at, confirmed, released
        FROM holds
        WHERE id = '${holdId.replace(/'/g, "''")}'
      `);

      if (holdRows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdRows[0];

      // Verify ownership
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold does not belong to this session' };
      }

      // Idempotency: already confirmed
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(`
          SELECT id, status, booked_by FROM seats WHERE hold_id = '${holdId.replace(/'/g, "''")}'
        `);
        return { alreadyConfirmed: true, seatIds: bookedSeats.map(r => r.id), holdId };
      }

      // Check if released (expired or manually released)
      if (hold.released) {
        throw { status: 410, error: 'Hold has been released or expired' };
      }

      // Check expiry
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt < new Date()) {
        // Mark as released
        await tx.exec(`
          UPDATE holds SET released = TRUE WHERE id = '${holdId.replace(/'/g, "''")}'
        `);
        throw { status: 410, error: 'Hold has expired' };
      }

      // Verify seats still belong to this hold
      const { rows: heldSeats } = await tx.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE hold_id = '${holdId.replace(/'/g, "''")}'
          AND status = 'held'
      `);

      if (heldSeats.length === 0) {
        throw { status: 410, error: 'Hold seats are no longer held (may have expired)' };
      }

      const seatIds = heldSeats.map(r => r.id);
      const seatIdList = seatIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');

      // Book the seats
      await tx.exec(`
        UPDATE seats
        SET status = 'booked',
            booked_by = '${sessionId.replace(/'/g, "''")}',
            hold_id = '${holdId.replace(/'/g, "''")}',
            hold_expires_at = NULL
        WHERE id IN (${seatIdList})
          AND hold_id = '${holdId.replace(/'/g, "''")}'
          AND status = 'held'
      `);

      // Mark hold as confirmed
      await tx.exec(`
        UPDATE holds SET confirmed = TRUE WHERE id = '${holdId.replace(/'/g, "''")}'
      `);

      return { alreadyConfirmed: false, seatIds, holdId };
    });

    // Broadcast booked event (only if newly confirmed)
    if (!result.alreadyConfirmed) {
      broadcastSeatUpdate('booked', result.seatIds.map(id => ({
        id,
        status: 'booked',
        holdId: result.holdId,
        bookedBy: sessionId
      })));
    }

    res.json({
      booking: {
        holdId: result.holdId,
        sessionId,
        seatIds: result.seatIds,
        status: 'booked'
      }
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    res.status(500).json({ error: 'Internal server error' });
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
    const result = await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(`
        SELECT id, session_id, confirmed, released
        FROM holds
        WHERE id = '${holdId.replace(/'/g, "''")}'
      `);

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
        return { alreadyReleased: true, seatIds: [] };
      }

      // Find held seats for this hold
      const { rows: heldSeats } = await tx.query(`
        SELECT id FROM seats
        WHERE hold_id = '${holdId.replace(/'/g, "''")}'
          AND status = 'held'
      `);

      const seatIds = heldSeats.map(r => r.id);

      if (seatIds.length > 0) {
        const seatIdList = seatIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
        await tx.exec(`
          UPDATE seats
          SET status = 'available',
              hold_id = NULL,
              hold_expires_at = NULL
          WHERE id IN (${seatIdList})
            AND hold_id = '${holdId.replace(/'/g, "''")}'
        `);
      }

      await tx.exec(`
        UPDATE holds SET released = TRUE WHERE id = '${holdId.replace(/'/g, "''")}'
      `);

      return { alreadyReleased: false, seatIds };
    });

    if (!result.alreadyReleased && result.seatIds.length > 0) {
      broadcastSeatUpdate('released', result.seatIds.map(id => ({
        id,
        status: 'available'
      })));
    }

    res.json({ released: true, seatIds: result.seatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
