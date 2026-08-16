/**
 * expiry.js – Utilities for enforcing hold TTL.
 *
 * `releaseExpiredHolds(db)` is called:
 *   • before every seat read (lazy expiry)
 *   • before every hold / confirm operation
 *   • on a periodic timer (background sweep)
 *
 * It returns the list of seat ids that were released so the caller can
 * broadcast the transitions.
 */

/**
 * Release all holds whose expires_at is in the past and whose seats are
 * still in the 'held' state.  Returns an array of seat ids that were freed.
 *
 * Must be called while the caller holds the serialisation mutex so that
 * the read-modify-write is atomic with respect to other operations.
 */
export async function releaseExpiredHolds(db) {
  // Find expired holds that still have held seats.
  const { rows: expiredHolds } = await db.query(`
    SELECT h.id AS hold_id
    FROM   holds h
    WHERE  h.expires_at <= NOW()
      AND  h.confirmed  = FALSE
      AND  EXISTS (
             SELECT 1 FROM seats s
             WHERE  s.hold_id = h.id
               AND  s.status  = 'held'
           )
  `);

  if (expiredHolds.length === 0) return [];

  const holdIds = expiredHolds.map(r => `'${r.hold_id}'`).join(',');

  // Collect the seat ids that will be freed (for broadcasting).
  const { rows: affectedSeats } = await db.query(`
    SELECT id FROM seats
    WHERE  hold_id = ANY(ARRAY[${holdIds}])
      AND  status  = 'held'
  `);

  if (affectedSeats.length === 0) return [];

  // Reset those seats to available.
  await db.exec(`
    UPDATE seats
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    WHERE  hold_id = ANY(ARRAY[${holdIds}])
      AND  status  = 'held';
  `);

  return affectedSeats.map(r => r.id);
}
