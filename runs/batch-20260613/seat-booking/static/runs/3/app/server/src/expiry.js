/**
 * Hold-expiry helpers.
 *
 * `releaseExpiredHolds` is called:
 *   - before every seat-read (lazy expiry)
 *   - before every hold/confirm operation (transactional safety)
 *   - on a periodic timer (background sweep)
 *
 * When holds are released their seats transition back to `available` and the
 * change is broadcast to all SSE clients.
 */

import { transaction } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all holds whose `expires_at` is in the past and whose seats have
 * not yet been booked.  Returns the list of seat ids that were released.
 *
 * Runs in its own transaction so the sweep is atomic.
 *
 * @returns {Promise<string[]>} released seat ids
 */
export async function releaseExpiredHolds() {
  let releasedSeatIds = [];

  await transaction(async (tx) => {
    releasedSeatIds = await releaseExpiredHoldsTx(tx);
  });

  if (releasedSeatIds.length > 0) {
    console.log(`[expiry] released ${releasedSeatIds.length} seat(s): ${releasedSeatIds.join(', ')}`);
    broadcast('seats:released', { seatIds: releasedSeatIds });
  }

  return releasedSeatIds;
}

/**
 * Release expired holds inside an existing transaction context.
 * Used by hold/confirm routes to ensure expiry is enforced atomically.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any> }} tx
 * @returns {Promise<string[]>} released seat ids
 */
export async function releaseExpiredHoldsTx(tx) {
  // Find expired, unconfirmed holds that still have held seats.
  const { rows: expiredHolds } = await tx.query(`
    SELECT h.id
    FROM   holds h
    WHERE  h.confirmed = FALSE
      AND  h.expires_at < NOW()
      AND  EXISTS (
             SELECT 1 FROM seats s
             WHERE  s.hold_id = h.id
               AND  s.status  = 'held'
           )
  `);

  if (expiredHolds.length === 0) return [];

  const releasedSeatIds = [];

  for (const hold of expiredHolds) {
    // Collect the seats that belong to this hold before releasing them.
    const { rows: seats } = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
      [hold.id],
    );

    // Release the seats.
    await tx.query(
      `UPDATE seats
       SET    status          = 'available',
              hold_id         = NULL,
              hold_expires_at = NULL
       WHERE  hold_id = $1
         AND  status  = 'held'`,
      [hold.id],
    );

    for (const seat of seats) {
      releasedSeatIds.push(seat.id);
    }
  }

  return releasedSeatIds;
}

// ---------------------------------------------------------------------------
// Background sweep – runs every 10 seconds
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 10_000;

export function startExpirySweep() {
  setInterval(async () => {
    try {
      await releaseExpiredHolds();
    } catch (err) {
      console.error('[expiry] sweep error:', err);
    }
  }, SWEEP_INTERVAL_MS);
  console.log(`[expiry] background sweep started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
}
