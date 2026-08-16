import { getDb } from './db.js';
import { broadcastSeats } from './sse.js';

/**
 * Release all holds whose expires_at is in the past.
 * Returns the list of seat ids that were released.
 * Must be called inside or outside a transaction — caller decides.
 */
export async function releaseExpiredHolds(db) {
  // Find seats that are held but whose hold has expired
  const result = await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at < NOW()
    RETURNING id, row_label, seat_number, status
  `);

  const released = result.rows;

  if (released.length > 0) {
    console.log(`[expiry] Released ${released.length} expired hold(s):`, released.map(s => s.id));
    broadcastSeats(
      released.map(s => ({ id: s.id, status: 'available' })),
      'seat_released'
    );
  }

  return released;
}

/**
 * Start a periodic sweep to release expired holds.
 * @param {number} intervalMs - how often to sweep (default 5 seconds)
 */
export async function startExpirySweep(intervalMs = 5000) {
  const sweep = async () => {
    try {
      const db = await getDb();
      await releaseExpiredHolds(db);
    } catch (err) {
      console.error('[expiry] Sweep error:', err);
    }
  };

  // Run immediately, then on interval
  await sweep();
  setInterval(sweep, intervalMs);
  console.log(`[expiry] Sweep started (every ${intervalMs}ms)`);
}
