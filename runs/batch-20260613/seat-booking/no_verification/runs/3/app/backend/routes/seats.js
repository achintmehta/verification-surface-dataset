import { Router } from 'express';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';
import { dbMutex } from '../mutex.js';

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its *effective* status.
 * Expires stale holds before reading so the response is always fresh.
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    const { rows, freedSeats } = await dbMutex.run(async () => {
      // Expire stale holds in their own committed transaction
      await db.exec('BEGIN');
      let freed = [];
      try {
        freed = await expireStaleHolds(db);
        await db.exec('COMMIT');
      } catch {
        await db.exec('ROLLBACK');
        freed = [];
      }

      // Read current seat state
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

      return { rows, freedSeats: freed };
    });

    // Broadcast any expiry events (outside the mutex is fine; broadcast is sync)
    if (freedSeats.length > 0) {
      broadcast('seats_released', {
        seats: freedSeats.map(s => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: 'available',
        })),
      });
    }

    res.json({ seats: rows });
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
