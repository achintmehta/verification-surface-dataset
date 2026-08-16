/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A held seat whose hold_expires_at is in the past is reported as 'available'.
 *   - Expired holds are lazily released before the query.
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Lazily release expired holds before reading.
    await releaseExpiredHolds(db);

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
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
