import { Router } from 'express';
import { getDb } from '../db.js';
import { expireHolds } from '../expiry.js';

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its current effective status.
 * Held seats whose hold_expires_at is in the past are reported as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // First, lazily expire any stale holds
    await expireHolds(db);

    const result = await db.query(`
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

    res.json({ seats: result.rows });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
