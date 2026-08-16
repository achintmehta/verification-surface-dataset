import { Router } from 'express';
import { getDb } from '../db.js';
import { expireHolds } from '../services/expiry.js';
import { broadcastSeatChanges } from './stream.js';

export function createSeatRoutes() {
  const router = Router();

  /**
   * GET /api/seats
   * Returns all seats with their effective status.
   * Seats with expired holds are reported as available.
   */
  router.get('/seats', async (req, res) => {
    try {
      // First, expire any stale holds
      const released = await expireHolds();
      if (released.length > 0) {
        broadcastSeatChanges(released);
      }

      const db = getDb();
      const result = await db.query(`
        SELECT 
          id,
          row_label,
          seat_number,
          CASE 
            WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available'
            ELSE status
          END as status,
          CASE 
            WHEN status = 'held' AND hold_expires_at <= NOW() THEN NULL
            ELSE hold_id
          END as hold_id,
          CASE 
            WHEN status = 'held' AND hold_expires_at <= NOW() THEN NULL
            ELSE hold_expires_at
          END as hold_expires_at,
          booked_by
        FROM seats
        ORDER BY row_label, seat_number
      `);

      res.json({ seats: result.rows });
    } catch (err) {
      console.error('Error fetching seats:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
