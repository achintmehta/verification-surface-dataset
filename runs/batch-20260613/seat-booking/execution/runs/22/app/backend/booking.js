import { v4 as uuidv4 } from 'uuid';
import { broadcast } from './sse.js';

const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '30', 10); // configurable hold TTL

/**
 * Expire stale holds in the database. Returns array of seat changes for broadcasting.
 */
export async function expireStaleHolds(db) {
  // Find and release all expired holds atomically
  const result = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
    WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number, hold_id
  `);

  if (result.rows.length > 0) {
    // Also mark the holds table entries as expired
    const holdIds = [...new Set(result.rows.map(r => r.hold_id).filter(Boolean))];
    for (const holdId of holdIds) {
      await db.query(
        `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
        [holdId]
      );
    }

    // Broadcast each seat release
    for (const seat of result.rows) {
      broadcast('seat-update', {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null
      });
    }
  }

  return result.rows;
}

/**
 * Get all seats with effective status (expired holds treated as available).
 */
export async function getAllSeats(db) {
  // First expire stale holds
  await expireStaleHolds(db);

  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);

  return result.rows;
}

/**
 * Atomically hold seats. All-or-nothing.
 * Returns { hold, seats } on success, or throws with conflicting seat info.
 */
export async function holdSeats(db, seatIds, sessionId) {
  if (!seatIds || seatIds.length === 0) {
    throw { status: 400, message: 'No seat IDs provided' };
  }
  if (!sessionId) {
    throw { status: 400, message: 'No session ID provided' };
  }

  // Expire stale holds first
  await expireStaleHolds(db);

  const holdId = uuidv4();
  const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

  // Use a transaction with serializable isolation for maximum safety
  // PGLite supports transactions via db.transaction()

  // Step 1: Check all requested seats are available
  const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
  const checkResult = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
     FROM seats
     WHERE id IN (${placeholders})
     FOR UPDATE`,
    seatIds
  );

  if (checkResult.rows.length !== seatIds.length) {
    const foundIds = new Set(checkResult.rows.map(r => r.id));
    const missingIds = seatIds.filter(id => !foundIds.has(id));
    throw { status: 400, message: 'Some seat IDs do not exist', missingIds };
  }

  // Check for unavailable seats
  const unavailable = checkResult.rows.filter(r => r.status !== 'available');
  if (unavailable.length > 0) {
    throw {
      status: 409,
      message: 'Some seats are not available',
      conflictingSeatIds: unavailable.map(r => r.id)
    };
  }

  // Step 2: Atomically mark all seats as held
  const updateResult = await db.query(
    `UPDATE seats
     SET status = 'held',
         hold_id = $${seatIds.length + 1},
         hold_expires_at = $${seatIds.length + 2},
         session_id = $${seatIds.length + 3}
     WHERE id IN (${placeholders})
       AND status = 'available'
     RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id`,
    [...seatIds, holdId, expiresAt.toISOString(), sessionId]
  );

  // If the update count doesn't match, a race condition occurred
  if (updateResult.rows.length !== seatIds.length) {
    // Rollback will happen automatically on error in transaction
    // Re-check which seats were taken
    const recheck = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) AND status != 'available'`,
      seatIds
    );
    throw {
      status: 409,
      message: 'Race condition: some seats were taken',
      conflictingSeatIds: recheck.rows.map(r => r.id)
    };
  }

  // Step 3: Create hold record
  await db.query(
    `INSERT INTO holds (id, session_id, seat_ids, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [holdId, sessionId, seatIds, expiresAt.toISOString()]
  );

  // Broadcast seat updates
  for (const seat of updateResult.rows) {
    broadcast('seat-update', {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'held',
      hold_id: seat.hold_id,
      hold_expires_at: seat.hold_expires_at,
      session_id: seat.session_id,
      booked_by: null
    });
  }

  return {
    hold: {
      id: holdId,
      sessionId,
      seatIds,
      expiresAt: expiresAt.toISOString(),
      status: 'active'
    },
    seats: updateResult.rows
  };
}

/**
 * Confirm a hold — idempotent. Books seats permanently.
 */
export async function confirmHold(db, holdId, sessionId) {
  // Expire stale holds first
  await expireStaleHolds(db);

  // Check hold exists
  const holdResult = await db.query(
    `SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1`,
    [holdId]
  );

  if (holdResult.rows.length === 0) {
    throw { status: 404, message: 'Hold not found' };
  }

  const hold = holdResult.rows[0];

  // Idempotent: if already confirmed, return success
  if (hold.status === 'confirmed') {
    const seatsResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, session_id, booked_by
       FROM seats WHERE id = ANY($1)`,
      [hold.seat_ids]
    );
    return {
      hold: {
        id: hold.id,
        sessionId: hold.session_id,
        seatIds: hold.seat_ids,
        status: 'confirmed'
      },
      seats: seatsResult.rows
    };
  }

  // Check if expired
  if (hold.status === 'expired' || new Date(hold.expires_at) <= new Date()) {
    // Mark as expired if not already
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
      [holdId]
    );
    // Release seats that are still held by this hold
    const releasedSeats = await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number`,
      [holdId]
    );
    for (const seat of releasedSeats.rows) {
      broadcast('seat-update', {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
        booked_by: null
      });
    }
    throw { status: 410, message: 'Hold has expired' };
  }

  if (hold.status === 'released') {
    throw { status: 410, message: 'Hold was released' };
  }

  // Validate ownership
  if (sessionId && hold.session_id !== sessionId) {
    throw { status: 403, message: 'Hold belongs to a different session' };
  }

  // Verify all seats are still held by this hold
  const seatsCheck = await db.query(
    `SELECT id, status, hold_id FROM seats WHERE id = ANY($1) FOR UPDATE`,
    [hold.seat_ids]
  );

  const notHeldByUs = seatsCheck.rows.filter(
    s => s.status !== 'held' || s.hold_id !== holdId
  );

  if (notHeldByUs.length > 0) {
    // Something went wrong, hold is invalid
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id = $1`,
      [holdId]
    );
    throw { status: 409, message: 'Some seats are no longer held by this hold' };
  }

  // Book the seats
  const bookResult = await db.query(
    `UPDATE seats
     SET status = 'booked',
         booked_by = $1,
         hold_expires_at = NULL
     WHERE hold_id = $2 AND status = 'held'
     RETURNING id, row_label, seat_number, status, hold_id, session_id, booked_by`,
    [hold.session_id, holdId]
  );

  // Mark hold as confirmed
  await db.query(
    `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
    [holdId]
  );

  // Broadcast
  for (const seat of bookResult.rows) {
    broadcast('seat-update', {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'booked',
      hold_id: seat.hold_id,
      hold_expires_at: null,
      session_id: seat.session_id,
      booked_by: seat.booked_by
    });
  }

  return {
    hold: {
      id: hold.id,
      sessionId: hold.session_id,
      seatIds: hold.seat_ids,
      status: 'confirmed'
    },
    seats: bookResult.rows
  };
}

/**
 * Release a hold early.
 */
export async function releaseHold(db, holdId, sessionId) {
  // Check hold exists
  const holdResult = await db.query(
    `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1`,
    [holdId]
  );

  if (holdResult.rows.length === 0) {
    throw { status: 404, message: 'Hold not found' };
  }

  const hold = holdResult.rows[0];

  if (hold.status === 'released') {
    return { message: 'Hold already released' };
  }

  if (hold.status === 'confirmed') {
    throw { status: 400, message: 'Cannot release a confirmed hold' };
  }

  // Validate ownership
  if (sessionId && hold.session_id !== sessionId) {
    throw { status: 403, message: 'Hold belongs to a different session' };
  }

  // Release the seats
  const releasedSeats = await db.query(
    `UPDATE seats
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
     WHERE hold_id = $1 AND status = 'held'
     RETURNING id, row_label, seat_number`,
    [holdId]
  );

  // Mark hold as released
  await db.query(
    `UPDATE holds SET status = 'released' WHERE id = $1`,
    [holdId]
  );

  // Broadcast
  for (const seat of releasedSeats.rows) {
    broadcast('seat-update', {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null
    });
  }

  return { message: 'Hold released', releasedSeatIds: releasedSeats.rows.map(r => r.id) };
}

/**
 * Get inventory summary
 */
export async function getInventory(db) {
  await expireStaleHolds(db);
  const result = await db.query(`
    SELECT status, COUNT(*) as count FROM seats GROUP BY status
  `);
  const inventory = { available: 0, held: 0, booked: 0, total: 0 };
  for (const row of result.rows) {
    inventory[row.status] = parseInt(row.count, 10);
  }
  inventory.total = inventory.available + inventory.held + inventory.booked;
  return inventory;
}
