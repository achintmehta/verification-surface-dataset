/**
 * Expiry helpers – release holds whose expires_at is in the past.
 * Called before every read/write operation AND on a periodic sweep.
 */
import { getDb } from './db.js';
import { broadcast } from './sse.js';

/**
 * Release all expired holds inside the given db connection (or a fresh one).
 * Returns the array of seat rows that were released.
 */
export async function releaseExpiredHolds(dbOverride) {
  const db = dbOverride || (await getDb());

  // Find seats that are held but whose hold has expired
  const expired = await db.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at <= NOW()
  `);

  if (expired.rows.length === 0) return [];

  // Reset those seats to available
  const ids = expired.rows.map((r) => `'${r.id}'`).join(', ');
  await db.exec(`
    UPDATE seats
    SET    status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
    WHERE  id IN (${ids});
  `);

  // Collect unique hold ids so we can mark them expired in the holds table
  const holdIds = [...new Set(expired.rows.map((r) => r.hold_id).filter(Boolean))];
  if (holdIds.length > 0) {
    const hids = holdIds.map((h) => `'${h}'`).join(', ');
    // We don't delete holds – we leave them so confirm can detect expiry
    // (the hold row still exists but the seats are now available)
    // Nothing extra needed here; the confirm path re-checks seat ownership.
    void hids; // suppress lint warning
  }

  // Broadcast each released seat
  const released = expired.rows.map((r) => ({
    id: r.id,
    row_label: r.row_label,
    seat_number: r.seat_number,
    status: 'available',
    hold_id: null,
    hold_expires_at: null,
    booked_by: null,
  }));

  broadcast('seats:updated', released);
  console.log(`[expiry] Released ${released.length} expired held seat(s).`);
  return released;
}

/**
 * Start a periodic sweep every `intervalMs` milliseconds.
 */
export function startExpirySweep(intervalMs = 5000) {
  const timer = setInterval(async () => {
    try {
      await releaseExpiredHolds();
    } catch (err) {
      console.error('[expiry] Sweep error:', err.message);
    }
  }, intervalMs);
  // Don't block process exit
  if (timer.unref) timer.unref();
  console.log(`[expiry] Sweep started (every ${intervalMs}ms).`);
}
