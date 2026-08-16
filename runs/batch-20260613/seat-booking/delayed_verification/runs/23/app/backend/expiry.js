// Expiry enforcement: releases holds whose TTL has passed
// Returns array of seat updates that were made (for broadcasting)

const { broadcast } = require('./sse');

async function expireStaleHolds(db) {
  // Atomically find and release all expired holds
  // 1. Update seats that have expired holds
  const expiredSeats = await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number
  `);

  // 2. Update the holds table to mark them expired
  await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE status = 'active'
      AND expires_at <= NOW()
  `);

  // Broadcast releases
  if (expiredSeats.rows.length > 0) {
    const updates = expiredSeats.rows.map(seat => ({
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null
    }));
    broadcast('seatUpdate', updates);
  }

  return expiredSeats.rows;
}

// Periodic sweep interval
let sweepInterval = null;

function startPeriodicSweep(db, intervalMs = 1000) {
  if (sweepInterval) clearInterval(sweepInterval);
  sweepInterval = setInterval(async () => {
    try {
      await expireStaleHolds(db);
    } catch (e) {
      console.error('Sweep error:', e);
    }
  }, intervalMs);
}

function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

module.exports = { expireStaleHolds, startPeriodicSweep, stopPeriodicSweep };
