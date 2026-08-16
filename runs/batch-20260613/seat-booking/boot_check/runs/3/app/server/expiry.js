/**
 * Hold expiry helpers.
 *
 * expireStaleHolds(db) – releases all holds whose expires_at is in the past
 * and returns the list of seat ids that were freed so the caller can broadcast.
 *
 * startExpiryLoop(db, broadcastFn, intervalMs) – runs expireStaleHolds on a
 * timer so abandoned holds are cleaned up even when no request triggers them.
 */

/**
 * Release every hold that has passed its TTL.
 * Returns an array of freed seat objects: { id, row_label, seat_number }.
 */
export async function expireStaleHolds(db) {
  // Find holds that are still 'active' but past their expiry time
  const { rows: expiredHolds } = await db.query(`
    SELECT id FROM holds
    WHERE status = 'active'
      AND expires_at <= NOW()
  `);

  if (expiredHolds.length === 0) return [];

  const expiredIds = expiredHolds.map((h) => `'${h.id}'`).join(', ');

  // Collect the seats that will be freed (for broadcasting)
  const { rows: freedSeats } = await db.query(`
    SELECT id, row_label, seat_number
    FROM seats
    WHERE hold_id IN (${expiredIds})
      AND status = 'held'
  `);

  if (freedSeats.length > 0) {
    // Release the seats
    await db.exec(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL
      WHERE hold_id IN (${expiredIds})
        AND status = 'held'
    `);
  }

  // Mark the holds as expired
  await db.exec(`
    UPDATE holds
    SET status = 'expired'
    WHERE id IN (${expiredIds})
  `);

  return freedSeats;
}

/**
 * Start a periodic sweep that expires stale holds and broadcasts the releases.
 */
export function startExpiryLoop(db, broadcastFn, intervalMs = 5000) {
  const tick = async () => {
    try {
      const freed = await expireStaleHolds(db);
      if (freed.length > 0) {
        console.log(`[expiry] Released ${freed.length} seat(s) from expired holds`);
        broadcastFn('seats:released', {
          seats: freed.map((s) => ({
            id: s.id,
            row_label: s.row_label,
            seat_number: s.seat_number,
            status: 'available',
          })),
        });
      }
    } catch (err) {
      console.error('[expiry] Error during sweep:', err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Don't block process exit
  if (timer.unref) timer.unref();
  return timer;
}
