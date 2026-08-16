/**
 * GET /api/seats
 * Returns every seat with its current effective status.
 * Held seats whose hold_expires_at is in the past are reported as 'available'.
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    // Eagerly release expired holds before responding
    await releaseExpiredHolds();

    const db = getDb();
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

    // Normalise: any held seat that slipped through (race) is reported available
    const now = Date.now();
    const seats = rows.map((seat) => {
      if (
        seat.status === 'held' &&
        seat.hold_expires_at &&
        new Date(seat.hold_expires_at).getTime() < now
      ) {
        return { ...seat, status: 'available', hold_id: null, hold_expires_at: null };
      }
      return seat;
    });

    res.json(seats);
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
