/**
 * Hold expiry helpers.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past
 * and returns the list of seat ids that were freed so callers can broadcast.
 *
 * startExpiryLoop(db, broadcastFn, intervalMs) – runs expireStaleHolds on a
 * timer so abandoned holds are cleaned up even when no request arrives.
 */

/**
 * Release every hold that has passed its TTL.
 * Must be called inside a serialised context (the caller owns the db mutex).
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array<{id:string, row_label:string, seat_number:number}>>}
 *   The seats that were freed.
 */
export async function expireStaleHolds(db) {
  // Find seats that are held but whose hold has expired
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Collect unique hold ids to mark as expired
  const holdIds = [...new Set(expiredSeats.map((s) => s.hold_id).filter(Boolean))];

  // Release the seats
  await db.query(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
  `);

  // Mark holds as expired
  if (holdIds.length > 0) {
    const placeholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `UPDATE holds
       SET    status = 'expired'
       WHERE  id IN (${placeholders})
         AND  status = 'active'`,
      holdIds
    );
  }

  return expiredSeats.map(({ id, row_label, seat_number }) => ({
    id,
    row_label,
    seat_number,
  }));
}

/**
 * Start a periodic sweep that expires stale holds and broadcasts releases.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {function} broadcastFn  - broadcast(event, data)
 * @param {number}   intervalMs   - sweep interval in milliseconds
 * @param {function} acquireLock  - async function that runs a callback with the db lock
 */
export function startExpiryLoop(db, broadcastFn, intervalMs, acquireLock) {
  setInterval(async () => {
    try {
      await acquireLock(async () => {
        const freed = await expireStaleHolds(db);
        if (freed.length > 0) {
          console.log(`[expiry] Released ${freed.length} stale seat(s):`, freed.map((s) => s.id));
          broadcastFn('seats:released', { seats: freed.map((s) => ({ id: s.id, status: 'available' })) });
        }
      });
    } catch (err) {
      console.error('[expiry] sweep error:', err);
    }
  }, intervalMs);
}
