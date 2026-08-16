import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcastSeatUpdate } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns all seats with their effective status.
 * Seats that are held but expired are reported as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Sweep expired holds first, broadcast any releases
    const released = await releaseExpiredHolds(db);
    if (released.length > 0) {
      broadcastSeatUpdate(released);
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

    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
