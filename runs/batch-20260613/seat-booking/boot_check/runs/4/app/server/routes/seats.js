import { Router } from 'express';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its current effective status.
 * Held seats whose hold_expires_at is in the past are reported as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Expire stale holds first (lazy expiry on read)
    const freed = await expireStaleHolds(db);
    if (freed.length > 0) {
      broadcast('seats:released', {
        seats: freed.map((s) => ({ id: s.id, status: 'available' })),
      });
    }

    const { rows } = await db.query(`
      SELECT
        id,
        row_label,
        seat_number,
        CASE
          WHEN status = 'held' AND hold_expires_at < NOW() THEN 'available'
          ELSE status
        END AS status,
        hold_id,
        CASE
          WHEN status = 'held' AND hold_expires_at >= NOW() THEN hold_expires_at
          ELSE NULL
        END AS hold_expires_at,
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
