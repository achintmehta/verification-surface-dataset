/**
 * Hold expiry helpers.
 *
 * expireHolds(db) – releases all holds whose expires_at is in the past,
 * returning the list of seat rows that were freed so callers can broadcast.
 *
 * startExpiryLoop(db, broadcastFn) – runs expireHolds on a periodic interval.
 */

/**
 * Release all expired holds inside a single transaction.
 * Returns an array of freed seat objects: { id, row_label, seat_number, status:'available' }
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>}
 */
export async function expireHolds(db) {
  const freed = [];

  await db.transaction(async (tx) => {
    // Find seats that are held but whose hold TTL has expired
    const { rows: expiredSeats } = await tx.query(`
      SELECT id, row_label, seat_number, hold_id
      FROM   seats
      WHERE  status = 'held'
        AND  hold_expires_at IS NOT NULL
        AND  hold_expires_at <= NOW()
      FOR UPDATE
    `);

    if (expiredSeats.length === 0) return;

    const ids = expiredSeats.map((s) => `'${s.id}'`).join(', ');

    await tx.query(`
      UPDATE seats
      SET    status          = 'available',
             hold_id         = NULL,
             hold_expires_at = NULL
      WHERE  id IN (${ids})
        AND  status = 'held'
        AND  hold_expires_at <= NOW()
    `);

    for (const s of expiredSeats) {
      freed.push({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: 'available',
      });
    }
  });

  return freed;
}

/**
 * Start a periodic sweep that expires stale holds and broadcasts releases.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {Function} broadcastFn  - broadcast(event, data)
 * @param {number}   intervalMs   - sweep interval in ms (default 5 s)
 */
export function startExpiryLoop(db, broadcastFn, intervalMs = 5000) {
  const sweep = async () => {
    try {
      const freed = await expireHolds(db);
      if (freed.length > 0) {
        console.log(`[expiry] Released ${freed.length} expired seat(s):`, freed.map((s) => s.id));
        broadcastFn('seats:released', { seats: freed });
      }
    } catch (err) {
      console.error('[expiry] sweep error:', err.message);
    }
  };

  const timer = setInterval(sweep, intervalMs);
  // Run once immediately on startup to clean up any stale state from a previous run
  sweep();
  return timer;
}
