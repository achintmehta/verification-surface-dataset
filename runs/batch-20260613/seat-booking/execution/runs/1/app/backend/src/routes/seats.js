/**
 * routes/seats.js – GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A seat whose hold has expired is reported as 'available' even if the
 *     database row still says 'held' (lazy expiry runs first).
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

export const seatsRouter = Router();

seatsRouter.get('/api/seats', async (req, res) => {
  try {
    // Lazy expiry: release stale holds before returning the seat list.
    await releaseExpiredHolds();

    const db = await getDb();

    const { rows } = await db.query(`
      SELECT
        id,
        row_label        AS "rowLabel",
        seat_number      AS "seatNumber",
        status,
        hold_id          AS "holdId",
        hold_expires_at  AS "holdExpiresAt",
        booked_by        AS "bookedBy"
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json(rows);
  } catch (err) {
    console.error('[GET /api/seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
