/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A seat whose hold has expired is reported as `available` even if the
 *     database row still says `held` (lazy expiry).
 *   - Expired holds are also released in the database so inventory stays
 *     consistent.
 */

import { Router } from 'express';
import { query } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    // Enforce expiry before reading so the response is always accurate.
    await releaseExpiredHolds();

    const { rows } = await query(`
      SELECT
        s.id,
        s.row_label,
        s.seat_number,
        s.status,
        s.hold_id,
        s.hold_expires_at,
        s.booked_by
      FROM seats s
      ORDER BY s.row_label, s.seat_number
    `);

    res.json({ seats: rows });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

export default router;
