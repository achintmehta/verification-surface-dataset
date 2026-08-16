/**
 * Holds routes
 *
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcastSeatUpdate } from '../sse.js';
import { dbMutex } from '../mutex.js';

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

  // Normalise + deduplicate.
  const uniqueIds = [...new Set(seatIds.map(String))];

  try {
    const db = await getDb();

    const result = await dbMutex.run(async () => {
      // 1. Release any expired holds first.
      const freed = await releaseExpiredHolds(db);

      // 2. Check availability of every requested seat in one query.
      const idList = uniqueIds.map(id => `'${id}'`).join(',');
      const { rows: seatRows } = await db.query(`
        SELECT id, status, hold_id AS "holdId", hold_expires_at AS "holdExpiresAt"
        FROM   seats
        WHERE  id = ANY(ARRAY[${idList}])
      `);

      // Verify all requested seats exist.
      if (seatRows.length !== uniqueIds.length) {
        const found = new Set(seatRows.map(r => r.id));
        const missing = uniqueIds.filter(id => !found.has(id));
        return { httpStatus: 404, body: { error: 'Unknown seat ids', missing } };
      }

      // Identify unavailable seats (held or booked).
      const unavailable = seatRows.filter(r => r.status !== 'available');
      if (unavailable.length > 0) {
        return {
          httpStatus: 409,
          body: {
            error: 'One or more seats are unavailable',
            conflictingSeatIds: unavailable.map(r => r.id),
          },
        };
      }

      // 3. Create the hold record.
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await db.exec(`
        INSERT INTO holds (id, session_id, expires_at, confirmed)
        VALUES ('${holdId}', '${sessionId.replace(/'/g, "''")}', '${expiresAt}', FALSE);
      `);

      // 4. Mark every seat as held – using a conditional UPDATE so a
      //    concurrent transaction that slipped through cannot overwrite.
      //    Even though the mutex serialises JS-level concurrency, this
      //    WHERE status = 'available' guard is a belt-and-suspenders check.
      const updateResult = await db.query(`
        UPDATE seats
        SET    status          = 'held',
               hold_id         = '${holdId}',
               hold_expires_at = '${expiresAt}'
        WHERE  id = ANY(ARRAY[${idList}])
          AND  status = 'available'
        RETURNING id
      `);

      // If we didn't update every seat, a race occurred – roll back.
      if (updateResult.rows.length !== uniqueIds.length) {
        // Undo the hold record; seats were not all updated.
        await db.exec(`DELETE FROM holds WHERE id = '${holdId}';`);
        const updated = new Set(updateResult.rows.map(r => r.id));
        const conflicting = uniqueIds.filter(id => !updated.has(id));
        return {
          httpStatus: 409,
          body: {
            error: 'One or more seats are unavailable (race condition)',
            conflictingSeatIds: conflicting,
          },
        };
      }

      return {
        httpStatus: 201,
        body: {
          hold: {
            id: holdId,
            sessionId,
            seatIds: uniqueIds,
            expiresAt,
            ttlSeconds: HOLD_TTL_SECONDS,
          },
        },
        freed,
        heldSeats: uniqueIds.map(id => ({ id, status: 'held', holdId, expiresAt })),
      };
    });

    // Broadcast outside the mutex.
    if (result.freed && result.freed.length > 0) {
      broadcastSeatUpdate(
        result.freed.map(id => ({ id, status: 'available', holdId: null, expiresAt: null }))
      );
    }
    if (result.heldSeats) {
      broadcastSeatUpdate(result.heldSeats);
    }

    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error('[POST /api/holds]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/holds/:holdId/confirm ────────────────────────────────────────
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    const result = await dbMutex.run(async () => {
      // 1. Release expired holds (may include this one).
      const freed = await releaseExpiredHolds(db);

      // 2. Load the hold.
      const { rows: holdRows } = await db.query(`
        SELECT id,
               session_id  AS "sessionId",
               expires_at  AS "expiresAt",
               confirmed
        FROM   holds
        WHERE  id = '${holdId}'
      `);

      if (holdRows.length === 0) {
        return { httpStatus: 404, body: { error: 'Hold not found' }, freed };
      }

      const hold = holdRows[0];

      // 3. Ownership check.
      if (hold.sessionId !== sessionId) {
        return { httpStatus: 403, body: { error: 'Hold belongs to a different session' }, freed };
      }

      // 4. Idempotency: already confirmed → return the existing booking.
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(`
          SELECT id FROM seats WHERE hold_id = '${holdId}'
        `);
        return {
          httpStatus: 200,
          body: {
            booking: {
              holdId,
              sessionId,
              seatIds: bookedSeats.map(r => r.id),
              status: 'booked',
            },
          },
          freed,
        };
      }

      // 5. Expiry check (after lazy release above, the hold's seats would
      //    have been freed; but double-check the timestamp for safety).
      const now = new Date();
      const expiresAt = new Date(hold.expiresAt);
      if (expiresAt <= now) {
        return { httpStatus: 410, body: { error: 'Hold has expired' }, freed };
      }

      // 6. Verify the hold still owns its seats.
      const { rows: heldSeats } = await db.query(`
        SELECT id FROM seats
        WHERE  hold_id = '${holdId}'
          AND  status  = 'held'
      `);

      if (heldSeats.length === 0) {
        return {
          httpStatus: 410,
          body: { error: 'Hold has no held seats (may have expired)' },
          freed,
        };
      }

      const seatIds = heldSeats.map(r => r.id);

      // 7. Book the seats atomically.
      await db.exec(`
        UPDATE seats
        SET    status          = 'booked',
               hold_expires_at = NULL,
               booked_by       = '${sessionId.replace(/'/g, "''")}'
        WHERE  hold_id = '${holdId}'
          AND  status  = 'held';
      `);

      // 8. Mark hold as confirmed.
      await db.exec(`
        UPDATE holds SET confirmed = TRUE WHERE id = '${holdId}';
      `);

      return {
        httpStatus: 200,
        body: {
          booking: {
            holdId,
            sessionId,
            seatIds,
            status: 'booked',
          },
        },
        freed,
        bookedSeats: seatIds.map(id => ({
          id,
          status: 'booked',
          holdId,
          expiresAt: null,
          bookedBy: sessionId,
        })),
      };
    });

    // Broadcast outside the mutex.
    if (result.freed && result.freed.length > 0) {
      broadcastSeatUpdate(
        result.freed.map(id => ({ id, status: 'available', holdId: null, expiresAt: null }))
      );
    }
    if (result.bookedSeats) {
      broadcastSeatUpdate(result.bookedSeats);
    }

    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error('[POST /api/holds/:holdId/confirm]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/holds/:holdId ──────────────────────────────────────────────
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();

    const result = await dbMutex.run(async () => {
      const freed = await releaseExpiredHolds(db);

      const { rows: holdRows } = await db.query(`
        SELECT id,
               session_id AS "sessionId",
               confirmed
        FROM   holds
        WHERE  id = '${holdId}'
      `);

      if (holdRows.length === 0) {
        return { httpStatus: 404, body: { error: 'Hold not found' }, freed };
      }

      const hold = holdRows[0];

      if (hold.sessionId !== sessionId) {
        return { httpStatus: 403, body: { error: 'Hold belongs to a different session' }, freed };
      }

      if (hold.confirmed) {
        return { httpStatus: 409, body: { error: 'Cannot release a confirmed hold' }, freed };
      }

      // Collect seats to release.
      const { rows: heldSeats } = await db.query(`
        SELECT id FROM seats
        WHERE  hold_id = '${holdId}'
          AND  status  = 'held'
      `);

      if (heldSeats.length > 0) {
        await db.exec(`
          UPDATE seats
          SET    status          = 'available',
                 hold_id         = NULL,
                 hold_expires_at = NULL
          WHERE  hold_id = '${holdId}'
            AND  status  = 'held';
        `);
      }

      // Remove the hold record.
      await db.exec(`DELETE FROM holds WHERE id = '${holdId}';`);

      return {
        httpStatus: 200,
        body: { released: true, seatIds: heldSeats.map(r => r.id) },
        freed,
        releasedSeats: heldSeats.map(r => r.id),
      };
    });

    if (result.freed && result.freed.length > 0) {
      broadcastSeatUpdate(
        result.freed.map(id => ({ id, status: 'available', holdId: null, expiresAt: null }))
      );
    }
    if (result.releasedSeats && result.releasedSeats.length > 0) {
      broadcastSeatUpdate(
        result.releasedSeats.map(id => ({ id, status: 'available', holdId: null, expiresAt: null }))
      );
    }

    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error('[DELETE /api/holds/:holdId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
