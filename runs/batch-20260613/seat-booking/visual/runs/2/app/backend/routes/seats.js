import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

const router = Router();

/**
 * GET /api/seats
 * Returns all seats with their effective current status.
 * Expired holds are treated as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Release expired holds first so the response is accurate
    await releaseExpiredHolds(db);

    const result = await db.query(`
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

    res.json({ seats: result.rows });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
