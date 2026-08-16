/**
 * Hold-expiry logic.
 *
 * `releaseExpiredHolds(db)` – run inside an existing transaction to sweep
 * any holds whose `expires_at` is in the past, reset the associated seats to
 * `available`, and return the list of affected seat ids so the caller can
 * broadcast the transitions.
 *
 * `startExpiryWorker()` – starts a periodic background sweep that runs
 * outside of any user request so that seats are freed even when no traffic
 * is hitting the server.
 */

import { withTx } from './db.js';
import { broadcast } from './sse.js';

const SWEEP_INTERVAL_MS = 5_000; // every 5 s

/**
 * Release all expired holds.
 * Must be called with an active DB connection (inside or outside a tx).
 * Returns the array of seat objects that were released.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array<{id:string, row_label:string, seat_number:number}>>}
 */
export async function releaseExpiredHolds(db) {
  // Find holds that have expired and are not yet confirmed.
  const { rows: expiredHolds } = await db.query(`
    SELECT id FROM holds
    WHERE expires_at <= now()
      AND confirmed = FALSE
  `);

  if (expiredHolds.length === 0) return [];

  const expiredIds = expiredHolds.map((h) => `'${h.id}'`).join(',');

  // Reset seats that belong to these holds.
  const { rows: releasedSeats } = await db.query(`
    UPDATE seats
    SET status          = 'available',
        hold_id         = NULL,
        hold_expires_at = NULL
    WHERE hold_id IN (${expiredIds})
      AND status = 'held'
    RETURNING id, row_label, seat_number
  `);

  // Delete the expired hold records.
  await db.query(`DELETE FROM holds WHERE id IN (${expiredIds})`);

  return releasedSeats;
}

/**
 * Sweep expired holds, broadcast any releases, and return released seats.
 * This wraps `releaseExpiredHolds` in its own transaction so it can be
 * called from the background worker.
 */
async function sweep() {
  try {
    const released = await withTx((db) => releaseExpiredHolds(db));
    if (released.length > 0) {
      broadcast('seats:released', {
        seats: released.map((s) => ({
          id: s.id,
          rowLabel: s.row_label,
          seatNumber: s.seat_number,
          status: 'available',
        })),
      });
      console.log(`[expiry] Released ${released.length} seat(s):`, released.map((s) => s.id));
    }
  } catch (err) {
    console.error('[expiry] Sweep error:', err);
  }
}

let _timer = null;

export function startExpiryWorker() {
  if (_timer) return;
  _timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Allow the process to exit even if the timer is running.
  if (_timer.unref) _timer.unref();
  console.log(`[expiry] Background sweep every ${SWEEP_INTERVAL_MS / 1000}s`);
}

export function stopExpiryWorker() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
