/**
 * Hold routes:
 *   POST   /api/holds                  – create a hold (all-or-nothing)
 *   POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 *   DELETE /api/holds/:holdId          – release a hold early
 *
 * All user-supplied values are passed as parameterized query parameters.
 * Seat IDs and hold IDs are validated to be safe identifiers before
 * being interpolated into IN-lists (PGLite does not support array params
 * for IN clauses).
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcastSeatUpdate } from '../sse.js';
import { withLock } from '../mutex.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Validate that a seat id is a safe alphanumeric identifier (e.g. "A1"). */
function isValidSeatId(id) {
  return typeof id === 'string' && /^[A-Z][0-9]{1,2}$/.test(id);
}

/** Validate that a hold id is a UUID. */
function isValidUUID(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

/** Build a safe SQL IN-list from pre-validated ids. */
function inList(ids) {
  return ids.map((id) => `'${id}'`).join(',');
}

/* ------------------------------------------------------------------ */
/*  POST /api/holds                                                     */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return res.status(400).json({ error: 'sessionId is required (max 128 chars)' });
  }

  // Deduplicate and validate seat IDs
  const uniqueSeatIds = [...new Set(seatIds)];
  const invalidIds = uniqueSeatIds.filter((id) => !isValidSeatId(id));
  if (invalidIds.length > 0) {
    return res.status(400).json({ error: 'Invalid seat ids', invalidIds });
  }

  try {
    const result = await withLock(async () => {
      const db = getDb();

      // 1. Release any expired holds first
      await releaseExpiredHolds();

      // 2. Check availability of ALL requested seats atomically
      const { rows: currentSeats } = await db.query(`
        SELECT id, status, hold_id AS "holdId", hold_expires_at AS "holdExpiresAt"
        FROM   seats
        WHERE  id IN (${inList(uniqueSeatIds)})
        FOR UPDATE
      `);

      // Verify all requested seats exist
      if (currentSeats.length !== uniqueSeatIds.length) {
        const foundIds = new Set(currentSeats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        return { status: 400, body: { error: 'Unknown seat ids', missing } };
      }

      // Find unavailable seats
      const unavailable = currentSeats.filter((s) => s.status !== 'available');
      if (unavailable.length > 0) {
        return {
          status: 409,
          body: {
            error: 'One or more seats are unavailable',
            conflictingSeatIds: unavailable.map((s) => s.id),
          },
        };
      }

      // 3. Create the hold record (use parameterized query for user data)
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed, released)
         VALUES ($1, $2, $3, FALSE, FALSE)`,
        [holdId, sessionId, expiresAt]
      );

      // 4. Mark seats as held (holdId is a UUID we generated, safe to interpolate)
      await db.exec(`
        UPDATE seats
        SET    status = 'held',
               hold_id = '${holdId}',
               hold_expires_at = '${expiresAt}'
        WHERE  id IN (${inList(uniqueSeatIds)});
      `);

      // 5. Fetch updated seats for broadcast
      const { rows: updatedSeats } = await db.query(`
        SELECT id, status,
               hold_id AS "holdId",
               hold_expires_at AS "holdExpiresAt",
               booked_by AS "bookedBy"
        FROM   seats
        WHERE  id IN (${inList(uniqueSeatIds)})
      `);

      return {
        status: 201,
        body: {
          hold: {
            id: holdId,
            sessionId,
            seatIds: uniqueSeatIds,
            expiresAt,
          },
        },
        broadcastSeats: updatedSeats,
      };
    });

    if (result.broadcastSeats) {
      broadcastSeatUpdate(result.broadcastSeats);
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/holds/:holdId/confirm                                     */
/* ------------------------------------------------------------------ */
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!isValidUUID(holdId)) {
    return res.status(400).json({ error: 'Invalid holdId' });
  }
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const result = await withLock(async () => {
      const db = getDb();

      // 1. Release expired holds first
      await releaseExpiredHolds();

      // 2. Fetch the hold (parameterized)
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id AS "sessionId", expires_at AS "expiresAt",
                confirmed, released
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdRows[0];

      // 3. Ownership check (parameterized comparison)
      if (hold.sessionId !== sessionId) {
        return { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      // 4. Idempotency: already confirmed → return existing booking
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(
          `SELECT id FROM seats WHERE booked_by = $1`,
          [holdId]
        );
        return {
          status: 200,
          body: {
            booking: {
              holdId,
              sessionId,
              seatIds: bookedSeats.map((s) => s.id),
            },
          },
        };
      }

      // 5. Expiry check
      if (hold.released || new Date(hold.expiresAt) <= new Date()) {
        return { status: 410, body: { error: 'Hold has expired or been released' } };
      }

      // 6. Verify seats still belong to this hold
      const { rows: heldSeats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        return { status: 409, body: { error: 'No seats are associated with this hold' } };
      }

      const seatIdList = inList(heldSeats.map((s) => s.id));

      // 7. Book the seats and mark hold confirmed
      await db.exec(`
        UPDATE seats
        SET    status = 'booked',
               hold_id = NULL,
               hold_expires_at = NULL,
               booked_by = '${holdId}'
        WHERE  id IN (${seatIdList});

        UPDATE holds
        SET    confirmed = TRUE
        WHERE  id = '${holdId}';
      `);

      // 8. Fetch updated seats for broadcast
      const { rows: updatedSeats } = await db.query(`
        SELECT id, status,
               hold_id AS "holdId",
               hold_expires_at AS "holdExpiresAt",
               booked_by AS "bookedBy"
        FROM   seats
        WHERE  id IN (${seatIdList})
      `);

      return {
        status: 200,
        body: {
          booking: {
            holdId,
            sessionId,
            seatIds: heldSeats.map((s) => s.id),
          },
        },
        broadcastSeats: updatedSeats,
      };
    });

    if (result.broadcastSeats) {
      broadcastSeatUpdate(result.broadcastSeats);
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`POST /api/holds/${req.params.holdId}/confirm error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/*  DELETE /api/holds/:holdId                                           */
/* ------------------------------------------------------------------ */
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!isValidUUID(holdId)) {
    return res.status(400).json({ error: 'Invalid holdId' });
  }
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const result = await withLock(async () => {
      const db = getDb();

      // Fetch the hold
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id AS "sessionId", confirmed, released
         FROM   holds
         WHERE  id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdRows[0];

      if (hold.sessionId !== sessionId) {
        return { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      if (hold.confirmed) {
        return { status: 409, body: { error: 'Cannot release a confirmed hold' } };
      }

      if (hold.released) {
        return { status: 200, body: { message: 'Hold already released' } };
      }

      // Find seats held by this hold
      const { rows: heldSeats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      if (heldSeats.length > 0) {
        const seatIdList = inList(heldSeats.map((s) => s.id));
        await db.exec(`
          UPDATE seats
          SET    status = 'available',
                 hold_id = NULL,
                 hold_expires_at = NULL
          WHERE  id IN (${seatIdList});
        `);
      }

      await db.exec(`UPDATE holds SET released = TRUE WHERE id = '${holdId}';`);

      // Fetch updated seats for broadcast
      let broadcastSeats = [];
      if (heldSeats.length > 0) {
        const seatIdList = inList(heldSeats.map((s) => s.id));
        const { rows: updatedSeats } = await db.query(`
          SELECT id, status,
                 hold_id AS "holdId",
                 hold_expires_at AS "holdExpiresAt",
                 booked_by AS "bookedBy"
          FROM   seats
          WHERE  id IN (${seatIdList})
        `);
        broadcastSeats = updatedSeats;
      }

      return {
        status: 200,
        body: { message: 'Hold released', seatIds: heldSeats.map((s) => s.id) },
        broadcastSeats,
      };
    });

    if (result.broadcastSeats && result.broadcastSeats.length > 0) {
      broadcastSeatUpdate(result.broadcastSeats);
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`DELETE /api/holds/${req.params.holdId} error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
