/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status:
 *   - A seat whose hold has expired is reported as `available` even if the
 *     database row still says `held` (lazy expiry).
 */

import { Router } from 'express';
import { query } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    // Lazily release any expired holds before reading
    await releaseExpiredHolds();

    const { rows } = await query(`
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

    // Compute effective status in JS as a safety net
    const now = Date.now();
    const seats = rows.map((seat) => {
      let effectiveStatus = seat.status;
      if (
        seat.status === 'held' &&
        seat.hold_expires_at &&
        new Date(seat.hold_expires_at).getTime() <= now
      ) {
        effectiveStatus = 'available';
      }
      return {
        id: seat.id,
        rowLabel: seat.row_label,
        seatNumber: seat.seat_number,
        status: effectiveStatus,
        holdId: effectiveStatus === 'held' ? seat.hold_id : null,
        holdExpiresAt:
          effectiveStatus === 'held' ? seat.hold_expires_at : null,
        bookedBy: seat.booked_by,
      };
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
