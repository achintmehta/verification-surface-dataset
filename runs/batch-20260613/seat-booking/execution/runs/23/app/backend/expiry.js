const { getDb } = require('./db');
const { broadcast } = require('./sse');

/**
 * Expire all holds past their TTL.
 * Returns the list of seat ids that were released.
 * This runs inside its own transaction.
 */
async function expireStaleHolds() {
  const db = await getDb();

  const released = await db.transaction(async (tx) => {
    // Find and release expired held seats
    const expiredSeats = await tx.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
      WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number, hold_id
    `);

    if (expiredSeats.rows.length > 0) {
      // Collect unique hold_ids to mark as expired
      const holdIds = [...new Set(expiredSeats.rows.map(r => r.hold_id).filter(Boolean))];

      for (const holdId of holdIds) {
        await tx.query(`
          UPDATE holds SET status = 'expired'
          WHERE id = $1 AND status = 'active'
        `, [holdId]);
      }
    }

    return expiredSeats.rows;
  });

  // Broadcast releases outside the transaction
  if (released.length > 0) {
    broadcast('seat-update', released.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null
    })));
  }

  return released;
}

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
