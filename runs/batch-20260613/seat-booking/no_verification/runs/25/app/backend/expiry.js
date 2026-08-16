import { getDb } from './db.js';
import { broadcast } from './sse.js';
import { withLock } from './lock.js';

/**
 * Expire all stale holds. Returns the list of seats that were released.
 * This must be called WITHIN a lock context (withLock), or calls withLock itself.
 * The internal version (_expireStaleHoldsUnsafe) does not acquire the lock -
 * it's meant to be called when the lock is already held.
 */
export async function _expireStaleHoldsUnsafe() {
  const db = await getDb();

  // Use a transaction to atomically find and release expired holds
  const result = await db.transaction(async (tx) => {
    // Find all seats that are held but whose hold has expired
    const expiredSeats = await tx.query(`
      SELECT s.id, s.row_label, s.seat_number, s.hold_id
      FROM seats s
      WHERE s.status = 'held'
        AND s.hold_expires_at IS NOT NULL
        AND s.hold_expires_at <= NOW()
    `);

    if (expiredSeats.rows.length === 0) return [];

    const seatIds = expiredSeats.rows.map(r => r.id);
    const holdIds = [...new Set(expiredSeats.rows.map(r => r.hold_id).filter(Boolean))];

    // Release the seats
    await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL,
          session_id = NULL
      WHERE id = ANY($1)
        AND status = 'held'
        AND hold_expires_at <= NOW()
    `, [seatIds]);

    // Mark the holds as expired
    if (holdIds.length > 0) {
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE id = ANY($1)
          AND status = 'active'
      `, [holdIds]);
    }

    return expiredSeats.rows;
  });

  // Broadcast releases outside the transaction
  if (result && result.length > 0) {
    for (const seat of result) {
      broadcast('seat-update', {
        seatId: seat.id,
        rowLabel: seat.row_label,
        seatNumber: seat.seat_number,
        status: 'available',
        holdId: null,
        sessionId: null
      });
    }
  }

  return result || [];
}

/**
 * Expire stale holds with lock acquisition.
 * Use this from the periodic sweep and from read endpoints.
 */
export async function expireStaleHolds() {
  return withLock(() => _expireStaleHoldsUnsafe());
}

let sweepInterval = null;

export function startPeriodicSweep(intervalMs = 2000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (e) {
      console.error('Sweep error:', e);
    }
  }, intervalMs);
}

export function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
