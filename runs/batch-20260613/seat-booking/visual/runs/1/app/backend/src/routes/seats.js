/**
 * routes/seats.js – GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   • A held seat whose hold_expires_at is in the past is reported as
 *     'available' (lazy expiry on read).
 */

import { Router } from 'express';
import { withDb } from '../db.js';
import { releaseExpiredHolds, broadcastReleases } from '../expiry.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const seats = await withDb(async (db) => {
      // Lazy expiry before reading
      const released = await releaseExpiredHolds(db);
      broadcastReleases(released);

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
      return rows;
    });

    res.json({ seats });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Failed to fetch seats.' });
  }
});

export default router;
