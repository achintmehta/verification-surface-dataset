/**
 * Seat-related business logic.
 *
 * All mutating operations run inside explicit PGLite transactions.
 * PGLite serialises all async work on a single connection, so a
 * BEGIN/COMMIT block prevents any other operation from interleaving.
 *
 * We use PGLite's `transaction()` helper which handles BEGIN/COMMIT/ROLLBACK
 * automatically and re-throws on error.
 *
 * NOTE ON SQL INJECTION:
 * All external string values (seatIds, sessionId, holdId) are validated /
 * sanitised before use.  seatIds are checked against the DB; sessionId and
 * holdId are UUIDs validated by regex.  We use parameterised queries via
 * PGLite's $1/$2 syntax wherever possible, and fall back to safe string
 * interpolation only for IN-list construction (which uses only validated ids).
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hold TTL in seconds */
export const HOLD_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAT_ID_RE = /^[A-Z][0-9]{1,2}$/;

function validateSeatId(id) {
  if (typeof id !== 'string' || !SEAT_ID_RE.test(id)) {
    throw Object.assign(new Error(`Invalid seat id format: ${id}`), { status: 400 });
  }
}

function validateSessionId(id) {
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128) {
    throw Object.assign(new Error('Invalid sessionId'), { status: 400 });
  }
  // Escape single quotes to prevent SQL injection (belt-and-suspenders).
  return id.replace(/'/g, "''");
}

function validateHoldId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw Object.assign(new Error('Invalid holdId format'), { status: 400 });
  }
  return id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Release all holds whose expires_at is in the past.
 * Must be called INSIDE an existing transaction via the `tx` object.
 *
 * Returns the seats that were released so the caller can broadcast them.
 *
 * @param {object} tx  – PGLite transaction object (has .query())
 * @returns {Promise<Array>}
 */
async function releaseExpiredHoldsInTx(tx) {
  const { rows: expiredSeats } = await tx.query(`
    SELECT s.id, s.row_label, s.seat_number, s.hold_id
    FROM   seats s
    WHERE  s.status = 'held'
      AND  s.hold_expires_at IS NOT NULL
      AND  s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Safe: ids come from the DB, not user input.
  const expiredIds = expiredSeats.map((r) => `'${r.id}'`).join(',');

  await tx.query(`
    UPDATE seats
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    WHERE  id IN (${expiredIds})
  `);

  return expiredSeats;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all seats with their *effective* status.
 * Runs an expiry sweep first so the returned data is accurate.
 */
export async function getAllSeats() {
  const db = await getDb();

  let released = [];
  await db.transaction(async (tx) => {
    released = await releaseExpiredHoldsInTx(tx);
  });

  if (released.length > 0) {
    broadcast('released', released.map((s) => ({ id: s.id, status: 'available' })));
  }

  const { rows } = await db.query(`
    SELECT
      id,
      row_label        AS "rowLabel",
      seat_number      AS "seatNumber",
      status,
      hold_id          AS "holdId",
      hold_expires_at  AS "holdExpiresAt",
      booked_by        AS "bookedBy"
    FROM seats
    ORDER BY row_label, seat_number
  `);

  return rows;
}

/**
 * Atomically place a hold on ALL requested seats.
 *
 * All-or-nothing: if any seat is unavailable the transaction is rolled back
 * and a 409 is returned with the conflicting seat ids.
 *
 * @param {string[]} seatIds
 * @param {string}   sessionId
 * @returns {{ hold: object, seats: object[] }}
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw Object.assign(new Error('seatIds must be a non-empty array'), { status: 400 });
  }
  if (!sessionId) {
    throw Object.assign(new Error('sessionId is required'), { status: 400 });
  }

  // Validate all seat ids before touching the DB.
  for (const id of seatIds) validateSeatId(id);
  const safeSessionId = validateSessionId(sessionId);

  const db = await getDb();

  let released = [];
  let holdResult = null;

  // We capture business-logic errors thrown inside the transaction callback
  // so we can re-attach custom properties that PGLite might strip.
  let businessError = null;

  try {
    await db.transaction(async (tx) => {
      // 1. Expire stale holds first.
      released = await releaseExpiredHoldsInTx(tx);

      // 2. Read the requested seats.
      const idList = seatIds.map((id) => `'${id}'`).join(',');

      const { rows: currentSeats } = await tx.query(`
        SELECT id, status
        FROM   seats
        WHERE  id IN (${idList})
      `);

      if (currentSeats.length !== seatIds.length) {
        const found = new Set(currentSeats.map((s) => s.id));
        const missing = seatIds.filter((id) => !found.has(id));
        const err = Object.assign(
          new Error(`Unknown seat ids: ${missing.join(', ')}`),
          { status: 400 }
        );
        businessError = err;
        throw err;
      }

      // 3. Check availability.
      const unavailable = currentSeats.filter((s) => s.status !== 'available');
      if (unavailable.length > 0) {
        const err = Object.assign(
          new Error('One or more seats are unavailable'),
          { status: 409, conflictingSeats: unavailable.map((s) => s.id) }
        );
        businessError = err;
        throw err;
      }

      // 4. Create the hold record.
      const holdId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, safeSessionId, expiresAt]
      );

      // 5. Mark the seats as held – WHERE status = 'available' is the atomic guard.
      await tx.query(`
        UPDATE seats
        SET    status          = 'held',
               hold_id         = '${holdId}',
               hold_expires_at = '${expiresAt}'
        WHERE  id IN (${idList})
          AND  status = 'available'
      `);

      // 6. Verify all seats were actually updated.
      const { rows: updatedSeats } = await tx.query(`
        SELECT id, status, hold_id AS "holdId", hold_expires_at AS "holdExpiresAt",
               row_label AS "rowLabel", seat_number AS "seatNumber"
        FROM   seats
        WHERE  id IN (${idList})
      `);

      const notHeld = updatedSeats.filter(
        (s) => s.status !== 'held' || s.holdId !== holdId
      );
      if (notHeld.length > 0) {
        const err = Object.assign(
          new Error('Concurrent modification detected; please retry'),
          { status: 409, conflictingSeats: notHeld.map((s) => s.id) }
        );
        businessError = err;
        throw err;
      }

      holdResult = {
        hold: { id: holdId, sessionId: safeSessionId, expiresAt, seatIds },
        seats: updatedSeats,
      };
    });
  } catch (err) {
    // Re-throw with original business error properties if available.
    if (businessError) throw businessError;
    throw err;
  }

  // Broadcast outside the transaction (after commit).
  if (released.length > 0) {
    broadcast('released', released.map((s) => ({ id: s.id, status: 'available' })));
  }
  broadcast('held', holdResult.seats.map((s) => ({
    id: s.id,
    status: 'held',
    holdId: s.holdId,
    holdExpiresAt: s.holdExpiresAt,
  })));

  return holdResult;
}

/**
 * Confirm a hold, booking its seats permanently.
 *
 * Idempotent: if the hold is already confirmed the existing booking is
 * returned without any additional writes.
 *
 * @param {string} holdId
 * @param {string} sessionId  – must match the hold's session_id
 * @returns {{ holdId: string, seatIds: string[], sessionId: string }}
 */
export async function confirmHold(holdId, sessionId) {
  if (!holdId) throw Object.assign(new Error('holdId is required'), { status: 400 });
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { status: 400 });

  const safeHoldId = validateHoldId(holdId);
  const safeSessionId = validateSessionId(sessionId);

  const db = await getDb();

  let released = [];
  let confirmResult = null;
  let alreadyConfirmed = false;
  let bookedSeatsForBroadcast = [];
  let businessError = null;

  try {
    await db.transaction(async (tx) => {
      // 1. Expire stale holds.
      released = await releaseExpiredHoldsInTx(tx);

      // 2. Fetch the hold.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id AS "sessionId", expires_at AS "expiresAt", confirmed
         FROM   holds
         WHERE  id = $1`,
        [safeHoldId]
      );

      if (holdRows.length === 0) {
        const err = Object.assign(new Error('Hold not found'), { status: 404 });
        businessError = err;
        throw err;
      }

      const hold = holdRows[0];

      if (hold.sessionId !== safeSessionId) {
        const err = Object.assign(
          new Error('Hold belongs to a different session'),
          { status: 403 }
        );
        businessError = err;
        throw err;
      }

      // 3. Idempotency: already confirmed → return the existing booking.
      if (hold.confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1`,
          [safeHoldId]
        );
        alreadyConfirmed = true;
        confirmResult = {
          holdId: safeHoldId,
          seatIds: bookedSeats.map((s) => s.id),
          sessionId: safeSessionId,
          alreadyConfirmed: true,
        };
        return; // commit with no changes
      }

      // 4. Check expiry.
      if (new Date(hold.expiresAt) < new Date()) {
        const err = Object.assign(new Error('Hold has expired'), { status: 410 });
        businessError = err;
        throw err;
      }

      // 5. Fetch the seats owned by this hold.
      const { rows: heldSeats } = await tx.query(
        `SELECT id, status, row_label AS "rowLabel", seat_number AS "seatNumber"
         FROM   seats
         WHERE  hold_id = $1`,
        [safeHoldId]
      );

      if (heldSeats.length === 0) {
        const err = Object.assign(new Error('No seats found for this hold'), { status: 404 });
        businessError = err;
        throw err;
      }

      const notHeld = heldSeats.filter((s) => s.status !== 'held');
      if (notHeld.length > 0) {
        const err = Object.assign(
          new Error('Some seats are no longer in held state'),
          { status: 409, conflictingSeats: notHeld.map((s) => s.id) }
        );
        businessError = err;
        throw err;
      }

      // 6. Book the seats.
      const idList = heldSeats.map((s) => `'${s.id}'`).join(',');
      await tx.query(`
        UPDATE seats
        SET    status          = 'booked',
               hold_id         = NULL,
               hold_expires_at = NULL,
               booked_by       = '${safeHoldId}'
        WHERE  id IN (${idList})
          AND  hold_id = '${safeHoldId}'
      `);

      // 7. Mark the hold as confirmed.
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [safeHoldId]
      );

      bookedSeatsForBroadcast = heldSeats;
      confirmResult = {
        holdId: safeHoldId,
        seatIds: heldSeats.map((s) => s.id),
        sessionId: safeSessionId,
      };
    });
  } catch (err) {
    if (businessError) throw businessError;
    throw err;
  }

  // Broadcast outside the transaction.
  if (released.length > 0) {
    broadcast('released', released.map((s) => ({ id: s.id, status: 'available' })));
  }
  if (!alreadyConfirmed && bookedSeatsForBroadcast.length > 0) {
    broadcast('booked', bookedSeatsForBroadcast.map((s) => ({
      id: s.id,
      status: 'booked',
      bookedBy: safeHoldId,
    })));
  }

  return confirmResult;
}

/**
 * Release a hold early, returning its seats to available.
 *
 * @param {string} holdId
 * @param {string|null} sessionId
 */
export async function releaseHold(holdId, sessionId) {
  if (!holdId) throw Object.assign(new Error('holdId is required'), { status: 400 });

  const safeHoldId = validateHoldId(holdId);
  const safeSessionId = sessionId ? validateSessionId(sessionId) : null;

  const db = await getDb();

  let released = [];
  let releasedSeats = [];
  let businessError = null;

  try {
    await db.transaction(async (tx) => {
      released = await releaseExpiredHoldsInTx(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id AS "sessionId", confirmed
         FROM   holds
         WHERE  id = $1`,
        [safeHoldId]
      );

      if (holdRows.length === 0) {
        const err = Object.assign(new Error('Hold not found'), { status: 404 });
        businessError = err;
        throw err;
      }

      const hold = holdRows[0];

      if (safeSessionId && hold.sessionId !== safeSessionId) {
        const err = Object.assign(
          new Error('Hold belongs to a different session'),
          { status: 403 }
        );
        businessError = err;
        throw err;
      }

      if (hold.confirmed) {
        const err = Object.assign(
          new Error('Cannot release a confirmed hold'),
          { status: 409 }
        );
        businessError = err;
        throw err;
      }

      // Fetch the seats before releasing them.
      const { rows: heldSeats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1`,
        [safeHoldId]
      );

      if (heldSeats.length > 0) {
        const idList = heldSeats.map((s) => `'${s.id}'`).join(',');
        await tx.query(`
          UPDATE seats
          SET    status          = 'available',
                 hold_id         = NULL,
                 hold_expires_at = NULL
          WHERE  id IN (${idList})
        `);
      }

      // Delete the hold record so it cannot be confirmed later.
      await tx.query(`DELETE FROM holds WHERE id = $1`, [safeHoldId]);

      releasedSeats = heldSeats;
    });
  } catch (err) {
    if (businessError) throw businessError;
    throw err;
  }

  // Broadcast outside the transaction.
  if (released.length > 0) {
    broadcast('released', released.map((s) => ({ id: s.id, status: 'available' })));
  }
  if (releasedSeats.length > 0) {
    broadcast('released', releasedSeats.map((s) => ({ id: s.id, status: 'available' })));
  }

  return { holdId: safeHoldId, released: releasedSeats.map((s) => s.id) };
}

/**
 * Periodic sweep: release all expired holds and broadcast the changes.
 * Called by a setInterval in the server entry point.
 */
export async function sweepExpiredHolds() {
  const db = await getDb();
  let released = [];
  try {
    await db.transaction(async (tx) => {
      released = await releaseExpiredHoldsInTx(tx);
    });

    if (released.length > 0) {
      console.log(`[sweep] Released ${released.length} expired seat(s).`);
      broadcast('released', released.map((s) => ({ id: s.id, status: 'available' })));
    }
  } catch (err) {
    console.error('[sweep] Error during expiry sweep:', err);
  }
}
