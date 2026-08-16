/**
 * Hold routes:
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, getHoldTtlSeconds } from '../db.js';
import { broadcast } from '../sse.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* Helper: release expired holds inside a transaction context           */
/* Optionally excludes a specific hold id from expiry (e.g. the one    */
/* being confirmed, so we can return 410 instead of 404).              */
/* Returns freed seat ids for broadcasting.                             */
/* ------------------------------------------------------------------ */
async function releaseExpiredHoldsInTx(tx, excludeHoldId = null) {
  let query = `
    SELECT id FROM holds
    WHERE  confirmed = FALSE
      AND  expires_at <= NOW()
  `;
  const params = [];

  if (excludeHoldId) {
    query += ` AND id != $1`;
    params.push(excludeHoldId);
  }

  const { rows: expiredHolds } = await tx.query(query, params);

  if (expiredHolds.length === 0) return [];

  const expiredIds = expiredHolds.map(h => h.id);
  const placeholders = expiredIds.map((_, i) => `$${i + 1}`).join(', ');

  // Free the seats.
  const { rows: freedSeats } = await tx.query(
    `UPDATE seats
     SET    status          = 'available',
            hold_id         = NULL,
            hold_expires_at = NULL
     WHERE  hold_id IN (${placeholders})
       AND  status = 'held'
     RETURNING id`,
    expiredIds
  );

  // Delete the expired holds.
  await tx.query(
    `DELETE FROM holds WHERE id IN (${placeholders})`,
    expiredIds
  );

  return freedSeats.map(s => s.id);
}

/* ------------------------------------------------------------------ */
/* POST /api/holds                                                       */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate.
  const uniqueSeatIds = [...new Set(seatIds)];

  const db = await getDb();

  try {
    // Run everything inside a single transaction so that concurrent requests
    // for the same seat cannot both succeed.
    // PGLite is single-connection and serialises all transactions, so
    // the FOR UPDATE lock ensures correctness.
    const result = await db.transaction(async (tx) => {
      // 1. Release expired holds first (inside the transaction).
      const freedIds = await releaseExpiredHoldsInTx(tx);

      // 2. Lock and read the requested seats.
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seatRows } = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      // Check all requested seats exist.
      if (seatRows.length !== uniqueSeatIds.length) {
        const found = new Set(seatRows.map(s => s.id));
        const missing = uniqueSeatIds.filter(id => !found.has(id));
        const err = new Error('Seats not found');
        err.status = 404;
        err.seatIds = missing;
        throw err;
      }

      // Check for conflicts (unavailable seats).
      const conflicts = seatRows.filter(s => s.status !== 'available');
      if (conflicts.length > 0) {
        const err = new Error('One or more seats are unavailable');
        err.status = 409;
        err.conflictingSeatIds = conflicts.map(s => s.id);
        throw err;
      }

      // 3. Create the hold record.
      const holdId = randomUUID();
      const ttl = getHoldTtlSeconds();
      const expiresAt = new Date(Date.now() + ttl * 1000);

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // 4. Mark seats as held.
      await tx.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = $2
         WHERE  id IN (${placeholders})`,
        [holdId, expiresAt.toISOString(), ...uniqueSeatIds]
      );

      return { holdId, sessionId, expiresAt, seatIds: uniqueSeatIds, ttl, freedIds };
    });

    // Broadcast expired releases.
    if (result.freedIds.length > 0) {
      broadcast('released', result.freedIds.map(id => ({ id, status: 'available' })));
    }

    // Broadcast the new hold.
    broadcast('held', result.seatIds.map(id => ({ id, status: 'held', holdId: result.holdId })));

    return res.status(201).json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.seatIds,
      expiresAt: result.expiresAt.toISOString(),
      ttlSeconds: result.ttl,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.conflictingSeatIds && { conflictingSeatIds: err.conflictingSeatIds }),
        ...(err.seatIds && { seatIds: err.seatIds }),
      });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/holds/:holdId/confirm                                       */
/* ------------------------------------------------------------------ */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // 1. Fetch the hold FIRST (before expiry sweep) so we can return
      //    the correct error code (410 vs 404).
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      // 2. Release OTHER expired holds (exclude this one so we can check it).
      const freedIds = await releaseExpiredHoldsInTx(tx, holdId);

      if (holdRows.length === 0) {
        const err = new Error('Hold not found');
        err.status = 404;
        throw err;
      }

      const hold = holdRows[0];

      // 3. Ownership check.
      if (hold.session_id !== sessionId) {
        const err = new Error('Hold does not belong to this session');
        err.status = 403;
        throw err;
      }

      // 4. Expiry check – return 410 if expired.
      if (new Date(hold.expires_at) <= new Date()) {
        // Clean up this expired hold now.
        await tx.query(
          `UPDATE seats
           SET    status          = 'available',
                  hold_id         = NULL,
                  hold_expires_at = NULL
           WHERE  hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

        const err = new Error('Hold has expired');
        err.status = 410;
        throw err;
      }

      // 5. Idempotency: already confirmed → return existing booking.
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1`,
          [holdId]
        );
        return {
          alreadyConfirmed: true,
          holdId,
          seatIds: bookedSeats.map(s => s.id),
          freedIds,
        };
      }

      // 6. Fetch and lock the held seats.
      const { rows: seatRows } = await tx.query(
        `SELECT id, status, hold_id
         FROM   seats
         WHERE  hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (seatRows.length === 0) {
        const err = new Error('No seats found for this hold');
        err.status = 409;
        throw err;
      }

      // Verify all seats still belong to this hold and are held.
      const badSeats = seatRows.filter(s => s.status !== 'held' || s.hold_id !== holdId);
      if (badSeats.length > 0) {
        const err = new Error('Seat state inconsistency detected');
        err.status = 409;
        throw err;
      }

      // 7. Book the seats.
      const seatIds = seatRows.map(s => s.id);
      const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(', ');

      await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                hold_id         = NULL,
                hold_expires_at = NULL,
                booked_by       = $1
         WHERE  id IN (${placeholders})`,
        [holdId, ...seatIds]
      );

      // 8. Mark hold as confirmed.
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return { alreadyConfirmed: false, holdId, seatIds, freedIds };
    });

    // Broadcast expired releases.
    if (result.freedIds.length > 0) {
      broadcast('released', result.freedIds.map(id => ({ id, status: 'available' })));
    }

    if (!result.alreadyConfirmed) {
      broadcast('booked', result.seatIds.map(id => ({ id, status: 'booked', bookedBy: holdId })));
    }

    return res.status(200).json({
      holdId: result.holdId,
      seatIds: result.seatIds,
      booked: true,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /api/holds/:holdId                                             */
/* ------------------------------------------------------------------ */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        const err = new Error('Hold not found');
        err.status = 404;
        throw err;
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        const err = new Error('Hold does not belong to this session');
        err.status = 403;
        throw err;
      }

      if (hold.confirmed) {
        const err = new Error('Cannot release a confirmed hold');
        err.status = 409;
        throw err;
      }

      // Free the seats.
      const { rows: freedSeats } = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
           AND  status  = 'held'
         RETURNING id`,
        [holdId]
      );

      // Delete the hold.
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return { seatIds: freedSeats.map(s => s.id) };
    });

    broadcast('released', result.seatIds.map(id => ({ id, status: 'available' })));

    return res.status(200).json({ released: true, seatIds: result.seatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
