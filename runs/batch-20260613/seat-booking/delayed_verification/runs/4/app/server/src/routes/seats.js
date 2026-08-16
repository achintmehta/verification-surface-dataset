/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *  - A seat whose hold_expires_at is in the past is reported as 'available'
 *    (lazy expiry on read).
 *  - We also opportunistically release those seats in the DB and broadcast
 *    the change so all clients converge.
 */

import { Router } from 'express';
import { getDb, withLock } from '../db.js';
import { expireStaleHoldsUnsafe } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    const seats = await withLock(async () => {
      // Expire stale holds first (lazy sweep on read).
      const released = await expireStaleHoldsUnsafe(db);
      if (released.length > 0) {
        broadcast(released);
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
      return rows;
    });

    res.json(seats);
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
