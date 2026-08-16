/**
 * Hold expiry logic.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past,
 * returning the list of affected seat rows so the caller can broadcast them.
 *
 * This is called:
 *   1. Before every seat read (lazy expiry on GET /api/seats).
 *   2. Inside every hold/confirm transaction (guarded by the transaction itself).
 *   3. By a periodic background sweep.
 */

/**
 * Release all stale holds and return the freed seats.
 * Must be called while holding the serialization mutex (or inside a transaction
 * that already handles its own expiry).
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>} freed seat rows
 */
export async function expireStaleHolds(db) {
  // Find seats whose hold has expired
  const { rows: expiredSeats } = await db.query(`
    SELECT id, row_label, seat_number
    FROM   seats
    WHERE  status = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  const expiredIds = expiredSeats.map(s => `'${s.id}'`).join(', ');

  // Release those seats
  await db.exec(`
    UPDATE seats
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    WHERE  id IN (${expiredIds})
      AND  status = 'held'
      AND  hold_expires_at < NOW()
  `);

  // Re-fetch the updated rows to return accurate state
  const { rows: freedSeats } = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM   seats
    WHERE  id IN (${expiredIds})
  `);

  return freedSeats;
}
