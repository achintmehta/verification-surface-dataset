/**
 * Expiry module: releases stale holds and broadcasts the resulting
 * seat-status changes.
 *
 * This is called:
 *  1. Lazily, before every seat read / hold / confirm operation.
 *  2. Periodically by a background sweep.
 */
import { getDb } from './db.js';
import { broadcastSeatUpdate } from './sse.js';

/**
 * Release all holds whose expires_at is in the past and that have not
 * already been confirmed or released.  Returns the number of seats freed.
 *
 * Must be called while holding the write mutex (callers serialise via
 * the mutex in routes).
 */
export async function releaseExpiredHolds() {
  const db = getDb();

  // Find seats that are still marked 'held' but whose hold has expired
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM   seats s
    JOIN   holds h ON h.id = s.hold_id
    WHERE  s.status = 'held'
      AND  h.confirmed = FALSE
      AND  h.released  = FALSE
      AND  h.expires_at <= NOW()
  `);

  if (expiredSeats.length === 0) return 0;

  // Collect unique hold ids to mark as released
  const holdIds = [...new Set(expiredSeats.map((r) => r.hold_id))];
  const holdIdList = holdIds.map((id) => `'${id}'`).join(',');
  const seatIdList = expiredSeats.map((r) => `'${r.id}'`).join(',');

  // Release seats and mark holds as released atomically
  await db.exec(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  id IN (${seatIdList});

    UPDATE holds
    SET    released = TRUE
    WHERE  id IN (${holdIdList});
  `);

  // Broadcast the released seats
  const released = expiredSeats.map((r) => ({
    id: r.id,
    status: 'available',
    holdId: null,
    holdExpiresAt: null,
    bookedBy: null,
  }));
  broadcastSeatUpdate(released);

  console.log(
    `Released ${expiredSeats.length} seat(s) from ${holdIds.length} expired hold(s).`
  );
  return expiredSeats.length;
}

/**
 * Start a periodic background sweep that releases expired holds.
 * The sweep acquires the write mutex so it doesn't race with requests.
 * @param {number} intervalMs  How often to sweep (default: 5 s)
 */
export function startExpirySweep(intervalMs = 5000) {
  // Import withLock lazily to avoid circular dependency
  let withLock;
  import('./mutex.js').then((m) => { withLock = m.withLock; });

  setInterval(async () => {
    if (!withLock) return; // not yet loaded
    try {
      await withLock(() => releaseExpiredHolds());
    } catch (err) {
      console.error('Expiry sweep error:', err.message);
    }
  }, intervalMs);
  console.log(`Expiry sweep started (every ${intervalMs / 1000}s).`);
}
