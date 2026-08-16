/**
 * Hold expiry helpers.
 *
 * Expiry is enforced in two complementary ways:
 *   1. Lazily – before every read/write operation we release any holds whose
 *      `hold_expires_at` is in the past.
 *   2. Periodically – a background sweep runs every SWEEP_INTERVAL_MS to catch
 *      holds that were never touched by a request.
 *
 * Both paths broadcast the released seats via SSE so every connected client
 * updates its seat map immediately.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

const SWEEP_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Release all holds whose `hold_expires_at` is in the past.
 *
 * Must be called inside a transaction or with the db lock already held when
 * used as part of a larger operation.  When called standalone it opens its
 * own implicit transaction via PGLite.
 *
 * @param {import('@electric-sql/pglite').PGlite} db  – pass the db instance to
 *   avoid re-fetching it (important when already inside a transaction).
 * @returns {Promise<Array>} the seats that were released
 */
export async function releaseExpiredHolds(db) {
  // Find all seats that are currently held but whose TTL has elapsed.
  const { rows: expiredSeats } = await db.query(`
    SELECT id, hold_id
    FROM   seats
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Collect unique hold IDs so we can mark the holds themselves as expired.
  const holdIds = [...new Set(expiredSeats.map((s) => s.hold_id).filter(Boolean))];

  // Reset the seats back to available.
  const seatIds = expiredSeats.map((s) => s.id);
  const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');

  await db.query(
    `UPDATE seats
     SET    status          = 'available',
            hold_id         = NULL,
            hold_expires_at = NULL
     WHERE  id IN (${placeholders})`,
    seatIds
  );

  // Remove the hold records so they can no longer be confirmed.
  if (holdIds.length > 0) {
    const holdPlaceholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `DELETE FROM holds WHERE id IN (${holdPlaceholders})`,
      holdIds
    );
  }

  // Build the payload for SSE broadcast.
  const releasedSeats = seatIds.map((id) => ({
    id,
    status: 'available',
    holdId: null,
    holdExpiresAt: null,
    bookedBy: null,
  }));

  return releasedSeats;
}

/**
 * Standalone sweep: release expired holds and broadcast the results.
 * Called by the periodic timer and can also be awaited directly.
 */
export async function sweepExpiredHolds() {
  try {
    const db = await getDb();
    const released = await releaseExpiredHolds(db);
    if (released.length > 0) {
      console.log(`[expiry] Released ${released.length} expired seat(s).`);
      broadcast('released', released);
    }
  } catch (err) {
    console.error('[expiry] Sweep error:', err);
  }
}

/**
 * Start the periodic background sweep.
 * Returns the interval handle so callers can clear it if needed.
 */
export function startExpirySweep() {
  const handle = setInterval(sweepExpiredHolds, SWEEP_INTERVAL_MS);
  // Allow the process to exit even if the interval is still active.
  if (handle.unref) handle.unref();
  console.log(`[expiry] Background sweep started (every ${SWEEP_INTERVAL_MS / 1000}s).`);
  return handle;
}
