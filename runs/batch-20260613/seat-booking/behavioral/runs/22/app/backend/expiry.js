const { broadcast } = require("./sse");

/**
 * Expire all stale holds in the database. Returns the list of seat ids that were released.
 * Must be called inside or outside a transaction — takes a db/tx handle.
 */
async function expireStaleHolds(dbOrTx) {
  // 1. Find seats whose holds have expired but are still marked held
  const expired = await dbOrTx.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_session_id = NULL,
        hold_expires_at = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at < NOW()
    RETURNING id, row_label, seat_number
  `);

  // 2. Mark the corresponding hold records as expired
  if (expired.rows.length > 0) {
    await dbOrTx.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at < NOW()
    `);
  }

  return expired.rows;
}

/**
 * Expire stale holds and broadcast released seats.
 */
async function expireAndBroadcast(db) {
  const released = await expireStaleHolds(db);
  if (released.length > 0) {
    broadcast("seats-updated", released.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: "available",
      hold_id: null,
      hold_session_id: null,
      hold_expires_at: null,
      booked_by: null,
    })));
  }
  return released;
}

module.exports = { expireStaleHolds, expireAndBroadcast };
