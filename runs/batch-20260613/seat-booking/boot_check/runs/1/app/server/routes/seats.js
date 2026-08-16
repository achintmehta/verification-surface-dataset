import { Router } from 'express';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its effective status.
 * Held seats whose TTL has elapsed are reported as available (and freed lazily).
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
        s.id,
        s.row_label,
        s.seat_number,
        s.status,
        s.hold_id,
        s.hold_expires_at,
        s.booked_by,
        h.session_id  AS hold_session_id,
        h.expires_at  AS hold_expires_at_utc
      FROM seats s
      LEFT JOIN holds h ON h.id = s.hold_id
      ORDER BY s.row_label, s.seat_number
    `);

    res.json({ seats: rows });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
