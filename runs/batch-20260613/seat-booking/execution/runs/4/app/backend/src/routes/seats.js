/**
 * routes/seats.js – GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A seat that is `held` but whose `hold_expires_at` is in the past is
 *     reported as `available` (and the stale hold is released first).
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    // Release any expired holds before reading, then broadcast the releases.
    const freed = await releaseExpiredHolds(db);
    if (freed.length > 0) {
      broadcast('seat-update', { type: 'released', seatIds: freed, status: 'available' });
    }

    const { rows } = await db.query(`
      SELECT
        id,
        row_label,
        seat_number,
        status,
        hold_id,
        hold_expires_at,
        booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json(rows);
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Failed to fetch seats.' });
  }
});

export default router;
