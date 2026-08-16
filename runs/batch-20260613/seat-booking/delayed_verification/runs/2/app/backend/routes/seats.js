/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   – A held seat whose hold_expires_at is in the past is reported as 'available'.
 *   – Expired holds are lazily released in the DB before the query so that
 *     subsequent requests also see the freed seats.
 *
 * Response: { seats: Seat[] }
 *
 * Seat shape:
 *   { id, rowLabel, seatNumber, status, holdId, holdExpiresAt, bookedBy }
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcastSeatUpdate } from '../sse.js';
import { dbMutex } from '../mutex.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Lazy expiry + broadcast inside the mutex so reads are consistent.
    const released = await dbMutex.run(async () => {
      const freed = await releaseExpiredHolds(db);
      return freed;
    });

    if (released.length > 0) {
      broadcastSeatUpdate(released.map(id => ({ id, status: 'available', holdId: null, expiresAt: null })));
    }

    // Read outside the mutex – reads are safe to run concurrently.
    const { rows } = await db.query(`
      SELECT
        id,
        row_label        AS "rowLabel",
        seat_number      AS "seatNumber",
        status,
        hold_id          AS "holdId",
        hold_expires_at  AS "holdExpiresAt",
        booked_by        AS "bookedBy"
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json({ seats: rows });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
