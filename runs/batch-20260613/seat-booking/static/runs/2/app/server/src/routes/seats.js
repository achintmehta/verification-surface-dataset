/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A seat whose hold has expired is reported as 'available' even if the
 *     database row still says 'held' (lazy expiry runs first).
 */

import { Router } from 'express';
import { query } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    // Lazy expiry: release stale holds before reading
    await releaseExpiredHolds();

    const { rows } = await query(`
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
