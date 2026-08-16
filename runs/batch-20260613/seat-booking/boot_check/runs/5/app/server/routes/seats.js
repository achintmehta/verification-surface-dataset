import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns all seats with their effective status.
 * Held seats whose hold_expires_at is in the past are reported as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Sweep expired holds first, then return seats
    const released = await releaseExpiredHolds(db);
    if (released.length > 0) {
      broadcast('released', released.map(r => ({
        id: r.id,
        status: 'available',
        holdId: null,
      })));
    }

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
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

export default router;
