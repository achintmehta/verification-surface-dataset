/**
 * Hold-expiry helpers.
 *
 * expireHolds(db) – releases all holds whose expires_at is in the past,
 *                   returns the affected seat rows so the caller can broadcast.
 *
 * startExpiryLoop(db, broadcastFn, intervalMs) – runs expireHolds on a timer.
 */

/**
 * Release every hold that has passed its TTL.
 * Must be called inside a serialised context (PGLite is single-writer anyway).
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<Array>} seats that were released (now available)
 */
export async function expireHolds(db) {
  // Find expired-but-still-held seats
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM   seats s
    JOIN   holds h ON h.id = s.hold_id
    WHERE  s.status = 'held'
      AND  h.expires_at <= NOW()
      AND  h.confirmed  = FALSE
  `);

  if (expiredSeats.length === 0) return [];

  const expiredHoldIds = [...new Set(expiredSeats.map((r) => r.hold_id))];
  const holdIdList = expiredHoldIds.map((id) => `'${id}'`).join(",");

  // Release the seats
  await db.exec(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  hold_id IN (${holdIdList})
      AND  status = 'held';
  `);

  // Mark the holds as expired (confirmed=false already; we just leave them)
  // We don't delete holds so idempotent confirm can still detect them as expired.

  return expiredSeats.map((s) => ({
    id: s.id,
    row_label: s.row_label,
    seat_number: s.seat_number,
    status: "available",
  }));
}

/**
 * Start a periodic sweep.
 * @param {Function} getDb   – async fn returning the db instance
 * @param {Function} broadcastFn – (event, data) => void
 * @param {number}   intervalMs
 * @returns {NodeJS.Timeout}
 */
export function startExpiryLoop(getDb, broadcastFn, intervalMs = 5000) {
  const timer = setInterval(async () => {
    try {
      const db = await getDb();
      const released = await expireHolds(db);
      if (released.length > 0) {
        broadcastFn("seat-update", {
          type: "released",
          seats: released,
        });
      }
    } catch (err) {
      console.error("[expiry-loop] error:", err.message);
    }
  }, intervalMs);

  // Don't block process exit
  if (timer.unref) timer.unref();
  return timer;
}
