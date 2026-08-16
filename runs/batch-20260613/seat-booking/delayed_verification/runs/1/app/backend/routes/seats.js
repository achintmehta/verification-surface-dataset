/**
 * GET /api/seats
 *
 * Returns every seat with its *effective* status.  Held seats whose TTL has
 * elapsed are reported as 'available' (and lazily released in the DB).
 */

import { Router } from 'express';
import { getDb }  from '../db.js';
import { sweepExpiredHolds, effectiveStatus, broadcastReleases } from '../expiry.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    let released = [];
    let seats;

    // No mutex needed for reads – the sweep is idempotent and the worst case
    // is a redundant release broadcast.  We still run it inside a transaction
    // so the sweep + read are consistent.
    await db.transaction(async (tx) => {
      released = await sweepExpiredHolds(tx);

      const { rows } = await tx.query(`
        SELECT id,
               row_label,
               seat_number,
               status,
               hold_id,
               hold_expires_at,
               booked_by
        FROM   seats
        ORDER  BY row_label, seat_number
      `);
      seats = rows;
    });

    // Broadcast any releases that happened during the sweep.
    broadcastReleases(released);

    // Map to client-facing shape; apply effectiveStatus as a safety net.
    const payload = seats.map((s) => ({
      id:            s.id,
      rowLabel:      s.row_label,
      seatNumber:    s.seat_number,
      status:        effectiveStatus(s),
      holdExpiresAt: effectiveStatus(s) === 'held' ? s.hold_expires_at : null,
      bookedBy:      s.booked_by ?? null,
    }));

    res.json(payload);
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
