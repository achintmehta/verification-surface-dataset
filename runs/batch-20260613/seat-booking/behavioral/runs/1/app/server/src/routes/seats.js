/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A seat whose hold has expired is reported as 'available' (and lazily
 *     released in the same transaction so the DB stays consistent).
 */

import { Router } from 'express';
import { getDb, sweepExpiredHolds } from '../db.js';
import { broadcast } from '../sse.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = getDb();

    // Lazily release expired holds and broadcast the releases
    const released = await sweepExpiredHolds(db);
    if (released.length > 0) {
      broadcast('seat-released', released.map((id) => ({ id, status: 'available' })));
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
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
