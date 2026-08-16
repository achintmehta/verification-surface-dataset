import { Router } from 'express';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its current effective status.
 * Held seats whose hold_expires_at is in the past are reported as available
 * (and lazily released in the DB).
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Lazily expire stale holds and broadcast releases
    const freed = await expireStaleHolds(db);
    if (freed.length > 0) {
      broadcast('released', freed);
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

    res.json({ seats: rows });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
