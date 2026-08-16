const { getDb } = require('./db');
const { broadcast } = require('./sse');
const { dbLock } = require('./lock');

/**
 * Expire all stale holds atomically. Returns the list of seat ids that were released.
 * This is called:
 *   - lazily before every seat read
 *   - periodically via setInterval
 * 
 * Uses the dbLock to ensure no interleaving with other transactions.
 */
async function expireStaleHolds() {
  let broadcastSeats = [];

  await dbLock.withLock(async () => {
    const db = await getDb();

    const result = await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active' AND expires_at <= NOW()
      RETURNING id, seat_ids
    `);

    if (result.rows.length === 0) return;

    const allReleasedSeatIds = [];
    const expiredHoldIds = [];

    for (const hold of result.rows) {
      expiredHoldIds.push(hold.id);
      const seatIds = Array.isArray(hold.seat_ids) ? hold.seat_ids : parsePgArray(hold.seat_ids);
      allReleasedSeatIds.push(...seatIds);
    }

    if (allReleasedSeatIds.length > 0) {
      const placeholders = expiredHoldIds.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id IN (${placeholders}) AND status = 'held'`,
        expiredHoldIds
      );

      // Fetch the released seats for broadcasting
      const seatPlaceholders = allReleasedSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const releasedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats WHERE id IN (${seatPlaceholders})`,
        allReleasedSeatIds
      );

      broadcastSeats = releasedSeats.rows;
    }
  });

  // Broadcast outside the lock to avoid potential issues
  for (const seat of broadcastSeats) {
    broadcast('seat-update', {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: seat.status,
      hold_id: seat.hold_id,
      hold_expires_at: seat.hold_expires_at,
      booked_by: seat.booked_by
    });
  }

  return broadcastSeats.map(s => s.id);
}

function parsePgArray(str) {
  if (!str) return [];
  const inner = str.replace(/^\{|\}$/g, '');
  if (!inner) return [];
  return inner.split(',').map(s => parseInt(s.trim(), 10));
}

// Start periodic sweep
let sweepInterval;

function startExpirySweep(intervalMs = 1000) {
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds();
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, intervalMs);
}

function stopExpirySweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

module.exports = { expireStaleHolds, startExpirySweep, stopExpirySweep };
