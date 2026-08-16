import { v4 as uuidv4 } from 'uuid';
import getDb from './db.js';
import { broadcast } from './sse.js';

/** Hold TTL in seconds */
const HOLD_TTL_SECONDS = 60;

/** Sweep interval in milliseconds */
const SWEEP_INTERVAL_MS = 5_000;

// ─── Expiry Sweep ────────────────────────────────────────────────────────────

/**
 * Release any seats whose hold has expired, mark their holds as expired,
 * and broadcast the change.
 * @returns {Promise<Array<{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null, booked_by: string|null}>>}
 */
export async function sweepExpiredHolds() {
  const db = await getDb();

  // We do this in a transaction so it's atomic
  const released = await db.transaction(async (/** @type {any} */ tx) => {
    // Find expired held seats
    const { rows: expiredSeats } = await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
      RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    `);

    if (expiredSeats.length > 0) {
      // Also mark the holds table entries as expired
      await tx.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= NOW()
      `);
    }

    return expiredSeats;
  });

  if (released.length > 0) {
    broadcast(released);
  }

  return released;
}

/**
 * Start the periodic sweep timer.
 */
export function startSweepTimer() {
  setInterval(() => {
    sweepExpiredHolds().catch((err) =>
      console.error('Sweep error:', err)
    );
  }, SWEEP_INTERVAL_MS);
}

// ─── Get All Seats ───────────────────────────────────────────────────────────

/**
 * Return every seat with its effective status.
 * Expired holds are treated as available.
 */
export async function getAllSeats() {
  // First sweep expired holds so DB is consistent
  await sweepExpiredHolds();

  const db = await getDb();
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number,
           CASE
             WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
             THEN 'available'
             ELSE status
           END AS status,
           CASE
             WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
             THEN NULL
             ELSE hold_id
           END AS hold_id,
           CASE
             WHEN status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
             THEN NULL
             ELSE hold_expires_at
           END AS hold_expires_at,
           booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return rows;
}

// ─── Hold Seats ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} HoldResult
 * @property {string} holdId
 * @property {string} expiresAt
 * @property {Array<{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null, booked_by: string|null}>} seats
 */

/**
 * Atomically hold the requested seats for a given session.
 * All-or-nothing: if any seat is unavailable, none are held and a 409 is signalled.
 *
 * @param {number[]} seatIds
 * @param {string} sessionId
 * @returns {Promise<{ok: true, hold: HoldResult} | {ok: false, conflicting: number[]}>}
 */
export async function holdSeats(seatIds, sessionId) {
  if (!seatIds || seatIds.length === 0) {
    throw new Error('seatIds must be a non-empty array');
  }
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const db = await getDb();
  const holdId = uuidv4();

  /** @type {{ok: true, hold: HoldResult} | {ok: false, conflicting: number[]}} */
  const result = await db.transaction(async (/** @type {any} */ tx) => {
    // First, expire any stale holds atomically inside this transaction
    await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
    `);
    await tx.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= NOW()
    `);

    // Lock and check the requested seats
    // Use FOR UPDATE to serialize concurrent transactions on same rows
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: currentSeats } = await tx.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    // Verify all requested seats exist
    if (currentSeats.length !== seatIds.length) {
      const foundIds = new Set(currentSeats.map((/** @type {any} */ s) => s.id));
      const missing = seatIds.filter((id) => !foundIds.has(id));
      throw new Error(`Seats not found: ${missing.join(', ')}`);
    }

    // Check for conflicts
    const conflicting = currentSeats
      .filter((/** @type {any} */ s) => s.status !== 'available')
      .map((/** @type {any} */ s) => s.id);

    if (conflicting.length > 0) {
      return { ok: false, conflicting };
    }

    // All seats available – acquire the hold
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // Update seats
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await tx.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $1,
           hold_expires_at = $2::timestamptz
       WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    // Insert hold record
    await tx.query(
      `INSERT INTO holds (id, session_id, seat_ids, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz)`,
      [holdId, sessionId, seatIds, expiresAt]
    );

    // Fetch updated seats for response / broadcast
    const selectPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: updatedSeats } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats WHERE id IN (${selectPlaceholders})`,
      seatIds
    );

    return {
      ok: true,
      hold: { holdId, expiresAt, seats: updatedSeats },
    };
  });

  if (result.ok) {
    broadcast(result.hold.seats);
  }

  return result;
}

// ─── Confirm Hold ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ConfirmResult
 * @property {string} holdId
 * @property {Array<{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null, booked_by: string|null}>} seats
 */

/**
 * Confirm a hold, booking its seats permanently.
 * Idempotent: confirming an already-confirmed hold returns the same result.
 *
 * @param {string} holdId
 * @returns {Promise<{ok: true, booking: ConfirmResult} | {ok: false, reason: string}>}
 */
export async function confirmHold(holdId) {
  if (!holdId) {
    throw new Error('holdId is required');
  }

  const db = await getDb();

  /** @type {{ok: true, booking: ConfirmResult} | {ok: false, reason: string}} */
  const result = await db.transaction(async (/** @type {any} */ tx) => {
    // First, expire any stale holds
    await tx.query(`
      UPDATE seats
      SET status = 'available',
          hold_id = NULL,
          hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= NOW()
    `);
    await tx.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= NOW()
    `);

    // Look up the hold
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1`,
      [holdId]
    );

    if (holdRows.length === 0) {
      return { ok: false, reason: 'Hold not found' };
    }

    const hold = holdRows[0];

    // Idempotent: if already confirmed, return the booked seats
    if (hold.status === 'confirmed') {
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((/** @type {any} */ _s, /** @type {number} */ i) => `$${i + 1}`).join(',');
      const { rows: seats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );
      return { ok: true, booking: { holdId, seats } };
    }

    // Reject expired or released holds
    if (hold.status === 'expired' || hold.status === 'released') {
      return { ok: false, reason: `Hold is ${hold.status}` };
    }

    // hold.status === 'active' — verify it hasn't expired
    if (new Date(hold.expires_at) <= new Date()) {
      // Mark as expired
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
      return { ok: false, reason: 'Hold has expired' };
    }

    const seatIds = hold.seat_ids;

    // Verify the seats are still held by this hold (use FOR UPDATE)
    const placeholders = seatIds.map((/** @type {any} */ _s, /** @type {number} */ i) => `$${i + 1}`).join(',');
    const { rows: currentSeats } = await tx.query(
      `SELECT id, status, hold_id FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    // All seats should be held by this holdId
    for (const seat of currentSeats) {
      if (seat.status !== 'held' || seat.hold_id !== holdId) {
        // This shouldn't happen if our logic is correct, but fail safely
        return { ok: false, reason: `Seat ${seat.id} is no longer held by this hold` };
      }
    }

    // Book the seats
    await tx.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = $1,
           hold_expires_at = NULL
       WHERE hold_id = $2`,
      [hold.session_id, holdId]
    );

    // Mark hold as confirmed
    await tx.query(
      `UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [holdId]
    );

    // Fetch updated seats
    const { rows: bookedSeats } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    return { ok: true, booking: { holdId, seats: bookedSeats } };
  });

  if (result.ok) {
    broadcast(result.booking.seats);
  }

  return result;
}

// ─── Release Hold ────────────────────────────────────────────────────────────

/**
 * Release a hold early, returning its seats to available.
 *
 * @param {string} holdId
 * @returns {Promise<{ok: true, seats: any[]} | {ok: false, reason: string}>}
 */
export async function releaseHold(holdId) {
  if (!holdId) {
    throw new Error('holdId is required');
  }

  const db = await getDb();

  const result = await db.transaction(async (/** @type {any} */ tx) => {
    // Look up the hold
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1`,
      [holdId]
    );

    if (holdRows.length === 0) {
      return { ok: false, reason: 'Hold not found' };
    }

    const hold = holdRows[0];

    // Can only release active holds; confirmed/expired/released are not releasable
    if (hold.status === 'confirmed') {
      return { ok: false, reason: 'Hold already confirmed, cannot release' };
    }

    if (hold.status === 'released') {
      // Idempotent: already released, just return the seats
      const seatIds = hold.seat_ids;
      const placeholders = seatIds.map((/** @type {any} */ _s, /** @type {number} */ i) => `$${i + 1}`).join(',');
      const { rows: seats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );
      return { ok: true, seats };
    }

    // Release the seats
    await tx.query(
      `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );

    // Mark hold as released
    await tx.query(
      `UPDATE holds SET status = 'released' WHERE id = $1`,
      [holdId]
    );

    // Fetch updated seats
    const seatIds = hold.seat_ids;
    const placeholders = seatIds.map((/** @type {any} */ _s, /** @type {number} */ i) => `$${i + 1}`).join(',');
    const { rows: releasedSeats } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );

    return { ok: true, seats: releasedSeats };
  });

  if (result.ok) {
    broadcast(result.seats);
  }

  return result;
}

// ─── Inventory Check ─────────────────────────────────────────────────────────

/**
 * Get exact inventory counts. Expired holds are treated as available.
 * @returns {Promise<{available: number, held: number, booked: number, total: number}>}
 */
export async function getInventory() {
  const db = await getDb();
  const { rows } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE
        status = 'available'
        OR (status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW())
      )::int AS available,
      COUNT(*) FILTER (WHERE
        status = 'held' AND (hold_expires_at IS NULL OR hold_expires_at > NOW())
      )::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked,
      COUNT(*)::int AS total
    FROM seats
  `);
  return rows[0];
}

export { HOLD_TTL_SECONDS };
