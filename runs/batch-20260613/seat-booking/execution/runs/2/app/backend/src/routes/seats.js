/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* current status.
 * A seat that is held but whose hold has expired is reported as 'available'.
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    // Lazily release any expired holds before returning the seat list.
    const released = await releaseExpiredHolds(db);
    if (released.length > 0) {
      broadcast('released', released);
    }

    const { rows } = await db.query(`
      SELECT
        id,
        row_label       AS "rowLabel",
        seat_number     AS "seatNumber",
        status,
        hold_id         AS "holdId",
        hold_expires_at AS "holdExpiresAt",
        booked_by       AS "bookedBy"
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
