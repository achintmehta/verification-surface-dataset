/**
 * GET /api/seats
 * Returns every seat with its current effective status.
 * Held seats whose hold_expires_at is in the past are reported as available.
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { withLock } from '../mutex.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const seats = await withLock(async () => {
      // Lazily release expired holds before returning seat list
      await releaseExpiredHolds();

      const db = getDb();
      const { rows } = await db.query(`
        SELECT
          id,
          row_label     AS "rowLabel",
          seat_number   AS "seatNumber",
          status,
          hold_id       AS "holdId",
          hold_expires_at AS "holdExpiresAt",
          booked_by     AS "bookedBy"
        FROM seats
        ORDER BY row_label, seat_number
      `);
      return rows;
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
