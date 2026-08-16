import { getDb } from './db.js';
import { broadcast } from './sse.js';

/**
 * Expire all stale holds: update seats whose hold has expired back to available,
 * and mark the corresponding hold records as expired.
 * Returns the list of seat ids that were released.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const released = [];

  // Find and release expired held seats in a single atomic operation
  const result = await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number, hold_id
  `);

  if (result.rows.length > 0) {
    // Collect unique hold_ids to mark as expired
    const holdIds = [...new Set(result.rows.map(r => r.hold_id).filter(Boolean))];

    for (const holdId of holdIds) {
      await db.query(`
        UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'
      `, [holdId]);
    }

    // Broadcast each released seat
    for (const row of result.rows) {
      released.push({
        id: row.id,
        row_label: row.row_label,
        seat_number: row.seat_number,
        status: 'available',
      });
    }

    if (released.length > 0) {
      broadcast('seats-updated', released);
    }
  }

  return released;
}

let sweepInterval = null;

/**
 * Start periodic sweep for expired holds.
 * Runs every `intervalMs` milliseconds.
 */
export function startExpirySweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, intervalMs);
  // Don't keep the process alive just for this timer
  if (sweepInterval.unref) sweepInterval.unref();
}

export function stopExpirySweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
