import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { broadcast } from './sse.js';

const HOLD_TTL_SECONDS = 60; // 60-second hold TTL

// Global request queue to serialize all mutating operations
// This ensures correctness since PGlite doesn't support true concurrent transactions
let operationQueue = Promise.resolve();

function enqueue(fn) {
  const result = operationQueue.then(fn, fn);
  // Update the queue but don't let errors propagate to future operations
  operationQueue = result.then(() => {}, () => {});
  return result;
}

/**
 * Expire all stale holds. This is the lazy sweep.
 * Must be called within a serialized context.
 */
async function expireStaleHolds(db) {
  // Find all seats with expired holds
  const expiredSeats = await db.query(`
    SELECT id, row_label, seat_number, hold_id
    FROM seats
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
  `);

  if (expiredSeats.rows.length === 0) return [];

  // Collect unique hold IDs to mark as expired
  const holdIds = [...new Set(expiredSeats.rows.map(s => s.hold_id).filter(Boolean))];

  // Release the seats
  await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
  `);

  // Mark holds as expired
  if (holdIds.length > 0) {
    const placeholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id IN (${placeholders}) AND status = 'active'`,
      holdIds
    );
  }

  return expiredSeats.rows.map(s => ({
    id: s.id,
    row_label: s.row_label,
    seat_number: s.seat_number,
    status: 'available',
    hold_id: null,
    hold_expires_at: null,
    session_id: null,
    booked_by: null
  }));
}

/**
 * Get all seats with effective status (expired holds shown as available)
 */
export async function getAllSeats() {
  return enqueue(async () => {
    const db = await getDb();

    // First expire stale holds
    const released = await expireStaleHolds(db);

    // Broadcast any releases
    for (const seat of released) {
      broadcast('seat-update', seat);
    }

    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    return result.rows;
  });
}

/**
 * Atomically hold seats - all or nothing
 */
export async function holdSeats(seatIds, sessionId) {
  return enqueue(async () => {
    const db = await getDb();

    // First expire stale holds
    const released = await expireStaleHolds(db);
    for (const seat of released) {
      broadcast('seat-update', seat);
    }

    // Check all requested seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
    const checkResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, session_id
       FROM seats
       WHERE id IN (${placeholders})`,
      seatIds
    );

    if (checkResult.rows.length !== seatIds.length) {
      const foundIds = checkResult.rows.map(r => r.id);
      const missingIds = seatIds.filter(id => !foundIds.includes(id));
      return { success: false, error: 'Some seats do not exist', missingIds };
    }

    const unavailable = checkResult.rows.filter(s => s.status !== 'available');
    if (unavailable.length > 0) {
      return {
        success: false,
        error: 'Some seats are not available',
        conflictingSeatIds: unavailable.map(s => s.id),
        status: 409
      };
    }

    // All seats are available — create hold and mark seats
    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // Insert hold record
    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, sessionId, expiresAt]
    );

    // Update all seats atomically
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(', ');
    await db.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $1,
           hold_expires_at = $2,
           session_id = $3
       WHERE id IN (${updatePlaceholders})
         AND status = 'available'`,
      [holdId, expiresAt, sessionId, ...seatIds]
    );

    // Fetch the updated seats to broadcast
    const updatedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    // Broadcast each seat update
    for (const seat of updatedSeats.rows) {
      broadcast('seat-update', seat);
    }

    return {
      success: true,
      hold: {
        id: holdId,
        sessionId,
        expiresAt,
        seatIds
      },
      seats: updatedSeats.rows
    };
  });
}

/**
 * Confirm a hold - idempotent
 */
export async function confirmHold(holdId) {
  return enqueue(async () => {
    const db = await getDb();

    // First expire stale holds
    const released = await expireStaleHolds(db);
    for (const seat of released) {
      broadcast('seat-update', seat);
    }

    // Check hold exists
    const holdResult = await db.query(
      `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      return { success: false, error: 'Hold not found', status: 404 };
    }

    const hold = holdResult.rows[0];

    // Idempotent: if already confirmed, return the booked seats
    if (hold.status === 'confirmed') {
      const bookedSeats = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      return {
        success: true,
        alreadyConfirmed: true,
        seats: bookedSeats.rows
      };
    }

    // Check if hold is expired or released
    if (hold.status === 'expired' || hold.status === 'released') {
      return { success: false, error: `Hold is ${hold.status}`, status: 410 };
    }

    // Check if hold has expired by time
    if (new Date(hold.expires_at) <= new Date()) {
      // Mark it expired
      await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      // Release the seats
      const expiredSeats = await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );
      for (const seat of expiredSeats.rows) {
        broadcast('seat-update', {
          ...seat,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
          booked_by: null
        });
      }
      return { success: false, error: 'Hold has expired', status: 410 };
    }

    // Verify seats are still held by this hold
    const heldSeats = await db.query(
      `SELECT id, row_label, seat_number FROM seats WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );

    if (heldSeats.rows.length === 0) {
      await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      return { success: false, error: 'Hold seats are no longer available', status: 410 };
    }

    // Confirm: mark seats as booked
    await db.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = $1,
           hold_expires_at = NULL
       WHERE hold_id = $2 AND status = 'held'`,
      [hold.session_id, holdId]
    );

    // Mark hold as confirmed
    await db.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

    // Fetch updated seats
    const bookedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
       FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    // Broadcast each seat update
    for (const seat of bookedSeats.rows) {
      broadcast('seat-update', seat);
    }

    return {
      success: true,
      alreadyConfirmed: false,
      seats: bookedSeats.rows
    };
  });
}

/**
 * Release a hold early
 */
export async function releaseHold(holdId) {
  return enqueue(async () => {
    const db = await getDb();

    // Check hold exists
    const holdResult = await db.query(
      `SELECT id, session_id, status FROM holds WHERE id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      return { success: false, error: 'Hold not found', status: 404 };
    }

    const hold = holdResult.rows[0];

    if (hold.status === 'confirmed') {
      return { success: false, error: 'Hold is already confirmed and cannot be released', status: 400 };
    }

    if (hold.status === 'released') {
      // Idempotent release
      return { success: true, alreadyReleased: true, seats: [] };
    }

    // Release the seats
    const releasedSeats = await db.query(
      `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL,
           session_id = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number`,
      [holdId]
    );

    // Mark hold as released
    await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    const updatedSeats = releasedSeats.rows.map(s => ({
      ...s,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      session_id: null,
      booked_by: null
    }));

    // Broadcast releases
    for (const seat of updatedSeats) {
      broadcast('seat-update', seat);
    }

    return { success: true, seats: updatedSeats };
  });
}

/**
 * Get seat inventory counts
 */
export async function getInventory() {
  return enqueue(async () => {
    const db = await getDb();

    // Expire stale holds first
    const released = await expireStaleHolds(db);
    for (const seat of released) {
      broadcast('seat-update', seat);
    }

    const result = await db.query(`
      SELECT status, COUNT(*)::int as count FROM seats GROUP BY status
    `);

    const inventory = { available: 0, held: 0, booked: 0 };
    for (const row of result.rows) {
      inventory[row.status] = row.count;
    }
    inventory.total = inventory.available + inventory.held + inventory.booked;

    return inventory;
  });
}

/**
 * Start periodic sweep for expired holds
 */
export function startExpirySweep(intervalMs = 5000) {
  const timer = setInterval(async () => {
    try {
      await enqueue(async () => {
        const db = await getDb();
        const released = await expireStaleHolds(db);
        for (const seat of released) {
          broadcast('seat-update', seat);
        }
      });
    } catch (e) {
      console.error('Expiry sweep error:', e);
    }
  }, intervalMs);

  return timer;
}
