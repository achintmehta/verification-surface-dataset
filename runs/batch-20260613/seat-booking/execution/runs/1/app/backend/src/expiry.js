/**
 * expiry.js – Hold expiry helpers.
 *
 * Two mechanisms enforce TTL expiry:
 *
 *  1. Lazy expiry: called before every seat read / hold / confirm operation.
 *     It releases any holds whose `expires_at` is in the past and broadcasts
 *     the resulting seat status changes.
 *
 *  2. Periodic sweep: a setInterval that calls the same logic every
 *     SWEEP_INTERVAL_MS so that seats are freed even when no requests arrive.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

const SWEEP_INTERVAL_MS = 10_000; // sweep every 10 s

/**
 * Release all holds whose `expires_at` is in the past.
 *
 * Returns the number of seats that were released.
 *
 * This function is safe to call concurrently: PGLite serialises all queries
 * through its internal queue, so two simultaneous calls will not double-release.
 */
export async function releaseExpiredHolds() {
  const db = await getDb();

  // Find seats that are currently held but whose hold has expired.
  // We join against the holds table to get the session info, but we also
  // handle the case where hold_expires_at is stored directly on the seat.
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return 0;

  // Collect unique hold ids so we can mark them in the holds table too.
  const expiredHoldIds = [...new Set(expiredSeats.map((r) => r.hold_id).filter(Boolean))];
  const expiredSeatIds = expiredSeats.map((r) => r.id);

  // Build parameterised IN list for seat ids.
  const seatPlaceholders = expiredSeatIds.map((_, i) => `$${i + 1}`).join(', ');

  // Reset the seats back to available.
  await db.query(
    `UPDATE seats
     SET    status          = 'available',
            hold_id         = NULL,
            hold_expires_at = NULL
     WHERE  id IN (${seatPlaceholders})
       AND  status = 'held'
       AND  hold_expires_at < NOW()`,
    expiredSeatIds
  );

  // Mark the holds as expired in the holds table (delete them so they cannot
  // be confirmed later).
  if (expiredHoldIds.length > 0) {
    const holdPlaceholders = expiredHoldIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `DELETE FROM holds WHERE id IN (${holdPlaceholders}) AND confirmed = FALSE`,
      expiredHoldIds
    );
  }

  // Broadcast the released seats.
  const updates = expiredSeatIds.map((id) => ({
    id,
    status: 'available',
    holdId: null,
    holdExpiresAt: null,
    bookedBy: null,
  }));
  broadcast(updates);

  console.log(`[expiry] Released ${expiredSeatIds.length} seat(s) from expired holds.`);
  return expiredSeatIds.length;
}

/**
 * Start the background sweep timer.
 * Call once at server startup.
 */
export function startExpirySweep() {
  setInterval(async () => {
    try {
      await releaseExpiredHolds();
    } catch (err) {
      console.error('[expiry] Sweep error:', err.message);
    }
  }, SWEEP_INTERVAL_MS);

  console.log(`[expiry] Sweep started (interval: ${SWEEP_INTERVAL_MS} ms).`);
}
