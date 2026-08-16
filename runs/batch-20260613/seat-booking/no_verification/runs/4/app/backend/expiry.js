/**
 * Hold expiry logic.
 *
 * expireHolds(db) – releases all holds whose expires_at is in the past,
 * returning the list of seat objects that were freed so the caller can
 * broadcast them.
 *
 * This function is safe to call inside an existing transaction (pass the
 * transaction client) or against the top-level db object.
 */

import { broadcast } from './sse.js';

/**
 * Release all expired holds.
 * Must be called while holding no other locks (it runs its own UPDATE).
 * Returns the array of freed seat rows.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>}  freed seat rows
 */
export async function expireHolds(db) {
  // Atomically find and release all seats whose hold has expired.
  // We use a CTE so we can capture the old hold_id before NULLing it.
  const result = await db.query(`
    WITH expired AS (
      SELECT id, hold_id
      FROM   seats
      WHERE  status = 'held'
        AND  hold_expires_at IS NOT NULL
        AND  hold_expires_at <= NOW()
    )
    UPDATE seats s
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    FROM   expired e
    WHERE  s.id = e.id
    RETURNING s.id, e.hold_id AS old_hold_id
  `);

  const freed = result.rows;

  if (freed.length > 0) {
    const expiredHoldIds = [...new Set(freed
      .map((s) => s.old_hold_id)
      .filter(Boolean))];

    if (expiredHoldIds.length > 0) {
      // Build parameterised IN list
      const placeholders = expiredHoldIds.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(
        `DELETE FROM holds WHERE id IN (${placeholders})`,
        expiredHoldIds
      );
    }

    // Broadcast each released seat
    for (const seat of freed) {
      broadcast('seat:released', {
        seatId: seat.id,
        status: 'available',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: null,
      });
    }

    console.log(`Expired ${freed.length} held seat(s) from hold(s): ${expiredHoldIds.join(', ')}.`);
  }

  return freed;
}

/**
 * Start a periodic sweep that releases stale holds every `intervalMs`.
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {number} intervalMs
 */
export function startExpirySweep(db, intervalMs = 5000) {
  const timer = setInterval(async () => {
    try {
      await expireHolds(db);
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, intervalMs);

  // Don't keep the process alive just for the sweep
  if (timer.unref) timer.unref();

  return timer;
}
