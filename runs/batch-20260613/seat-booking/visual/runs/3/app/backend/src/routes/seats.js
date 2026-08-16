import { Router } from 'express';
import { getDb, sweepExpiredHolds } from '../db.js';
import { broadcastSeatUpdate } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns all seats with their effective current status.
 * Held seats whose hold_expires_at is in the past are reported as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Sweep expired holds first, broadcast any releases
    const releasedIds = await sweepExpiredHolds(db);
    if (releasedIds.length > 0) {
      const releasedSeats = releasedIds.map(id => ({ id, status: 'available' }));
      broadcastSeatUpdate('released', releasedSeats);
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
