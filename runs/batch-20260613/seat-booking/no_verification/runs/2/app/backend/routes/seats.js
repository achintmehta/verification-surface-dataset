import { Router } from 'express';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its *effective* status:
 *   - A held seat whose hold_expires_at is in the past is reported as available.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Expire stale holds in a committed transaction, then broadcast releases
    await db.exec('BEGIN');
    const freed = await expireStaleHolds(db);
    await db.exec('COMMIT');

    if (freed.length > 0) {
      broadcast('seats:released', { seats: freed });
    }

    // Read current seat state (expired holds already cleaned up above)
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
