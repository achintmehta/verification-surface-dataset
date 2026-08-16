/**
 * Core seat-booking business logic.
 *
 * Atomicity strategy:
 *   createHold  – SELECT … FOR UPDATE to lock rows, then conditional UPDATE.
 *                 If any seat is unavailable after locking, roll back → 409.
 *   confirmHold – SELECT … FOR UPDATE on the hold row serialises concurrent confirms.
 *   releaseHold – SELECT … FOR UPDATE on the hold row prevents double-release.
 *
 * PGlite serialises all SQL queries through a single queue, so FOR UPDATE
 * provides the correct row-level isolation even under concurrent JS requests.
 */

import { v4 as uuidv4 } from 'uuid';
import { HOLD_TTL_SECONDS } from './db.js';
import { broadcast } from './sse.js';

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Release all seats whose hold has expired (hold_expires_at < NOW()).
 * Returns the released seat objects { id, status: 'available' }.
 * Safe to call both inside and outside a transaction.
 */
async function expireStaleHolds(db) {
  const { rows } = await db.query(`
    UPDATE seats
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    WHERE  status          = 'held'
      AND  hold_expires_at IS NOT NULL
      AND  hold_expires_at < NOW()
    RETURNING id
  `);
  return rows.map((r) => ({ id: r.id, status: 'available' }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return all seats with their effective status.
 * Expired holds are lazily released before the SELECT.
 */
export async function getAllSeats(db) {
  const released = await expireStaleHolds(db);
  if (released.length > 0) broadcast('released', released);

  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, status,
           hold_id, hold_expires_at, booked_by
    FROM   seats
    ORDER  BY row_label, seat_number
  `);
  return rows;
}

/**
 * Atomically place a hold on ALL requested seats (all-or-nothing).
 *
 * Uses SELECT … FOR UPDATE to lock the rows, then checks availability.
 * If any seat is unavailable, the transaction is rolled back → 409.
 *
 * Returns { hold, seats } on success.
 * Throws with .conflict / .notFound / .badRequest as appropriate.
 */
export async function createHold(db, seatIds, sessionId) {
  if (!seatIds || seatIds.length === 0) {
    throw Object.assign(new Error('No seat IDs provided'), { badRequest: true });
  }

  const uniqueIds = [...new Set(seatIds)];

  let releasedSeats = [];
  let heldSeats    = [];
  let hold         = null;
  let committed    = false;

  await db.transaction(async (tx) => {
    // 1. Expire stale holds so freshly-expired seats become available
    releasedSeats = await expireStaleHolds(tx);

    // 2. Lock the requested seats (FOR UPDATE prevents concurrent holds)
    const ph = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: locked } = await tx.query(
      `SELECT id, status FROM seats WHERE id IN (${ph}) FOR UPDATE`,
      uniqueIds
    );

    // 3. Verify all requested seat IDs exist
    if (locked.length !== uniqueIds.length) {
      const found   = new Set(locked.map((r) => r.id));
      const missing = uniqueIds.filter((id) => !found.has(id));
      throw Object.assign(new Error(`Unknown seat IDs: ${missing.join(', ')}`), {
        notFound: true,
        missingIds: missing,
      });
    }

    // 4. All-or-nothing availability check
    const unavailable = locked.filter((r) => r.status !== 'available');
    if (unavailable.length > 0) {
      throw Object.assign(new Error('One or more seats are unavailable'), {
        conflict: true,
        conflictingSeats: unavailable.map((r) => r.id),
      });
    }

    // 5. Claim all seats (all are available and locked)
    const holdId    = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);
    // $1=holdId, $2=expiresAt, $3...$N+2=seatIds
    const updatePh  = uniqueIds.map((_, i) => `$${i + 3}`).join(', ');

    await tx.query(
      `UPDATE seats
       SET    status          = 'held',
              hold_id         = $1,
              hold_expires_at = $2
       WHERE  id IN (${updatePh})`,
      [holdId, expiresAt.toISOString(), ...uniqueIds]
    );

    // 6. Create the hold record
    await tx.query(
      `INSERT INTO holds (id, session_id, expires_at, confirmed)
       VALUES ($1, $2, $3, FALSE)`,
      [holdId, sessionId, expiresAt.toISOString()]
    );

    // 7. Fetch updated seats for the response
    const { rows: updated } = await tx.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
       FROM   seats
       WHERE  id IN (${ph})`,
      uniqueIds
    );

    hold      = { id: holdId, sessionId, expiresAt, seatIds: uniqueIds };
    heldSeats = updated;
    committed = true;
  });

  // Only broadcast if the transaction committed
  if (committed) {
    if (releasedSeats.length > 0) broadcast('released', releasedSeats);
    broadcast('held', heldSeats.map((s) => ({
      id:            s.id,
      status:        'held',
      holdId:        s.hold_id,
      holdExpiresAt: s.hold_expires_at,
    })));
  }

  return { hold, seats: heldSeats };
}

/**
 * Confirm a hold, booking its seats permanently.
 * Idempotent: a second confirm of the same hold returns the same result.
 *
 * Throws with .expired / .notFound / .forbidden / .conflict as appropriate.
 */
export async function confirmHold(db, holdId, sessionId) {
  let bookedSeats      = [];
  let result           = null;
  let alreadyConfirmed = false;

  await db.transaction(async (tx) => {
    // 1. Expire stale holds
    await expireStaleHolds(tx);

    // 2. Lock the hold row to serialise concurrent confirms
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, expires_at, confirmed
       FROM   holds
       WHERE  id = $1
       FOR UPDATE`,
      [holdId]
    );
    if (holdRows.length === 0) {
      throw Object.assign(new Error('Hold not found'), { notFound: true });
    }

    const hold = holdRows[0];

    // 3. Ownership check
    if (hold.session_id !== sessionId) {
      throw Object.assign(new Error('Hold belongs to a different session'), {
        forbidden: true,
      });
    }

    // 4. Idempotency: already confirmed → return existing booking
    if (hold.confirmed) {
      alreadyConfirmed = true;
      const { rows: seats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      result = {
        holdId,
        sessionId,
        bookedSeatIds:    seats.map((s) => s.id),
        alreadyConfirmed: true,
      };
      return;
    }

    // 5. Expiry check (checked after idempotency so confirmed holds never 410)
    if (new Date(hold.expires_at) < new Date()) {
      throw Object.assign(new Error('Hold has expired'), { expired: true });
    }

    // 6. Atomically book all held seats for this hold
    const { rows: booked } = await tx.query(
      `UPDATE seats
       SET    status          = 'booked',
              booked_by       = $1,
              hold_expires_at = NULL
       WHERE  hold_id = $2
         AND  status  = 'held'
       RETURNING id`,
      [sessionId, holdId]
    );
    if (booked.length === 0) {
      throw Object.assign(new Error('No held seats found for this hold'), {
        notFound: true,
      });
    }

    // 7. Mark hold as confirmed
    await tx.query(`UPDATE holds SET confirmed = TRUE WHERE id = $1`, [holdId]);

    bookedSeats = booked.map((s) => ({ id: s.id, status: 'booked', holdId }));
    result = {
      holdId,
      sessionId,
      bookedSeatIds:    booked.map((s) => s.id),
      alreadyConfirmed: false,
    };
  });

  if (!alreadyConfirmed && bookedSeats.length > 0) {
    broadcast('booked', bookedSeats);
  }

  return result;
}

/**
 * Release a hold early, returning its seats to available.
 * Throws with .notFound or .forbidden as appropriate.
 */
export async function releaseHold(db, holdId, sessionId) {
  let releasedSeats = [];

  await db.transaction(async (tx) => {
    // 1. Lock the hold
    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, expires_at, confirmed
       FROM   holds
       WHERE  id = $1
       FOR UPDATE`,
      [holdId]
    );
    if (holdRows.length === 0) {
      throw Object.assign(new Error('Hold not found'), { notFound: true });
    }

    const hold = holdRows[0];

    if (hold.session_id !== sessionId) {
      throw Object.assign(new Error('Hold belongs to a different session'), {
        forbidden: true,
      });
    }

    // Already confirmed/booked — nothing to release
    if (hold.confirmed) return;

    // 2. Release the seats
    const { rows: seats } = await tx.query(
      `UPDATE seats
       SET    status          = 'available',
              hold_id         = NULL,
              hold_expires_at = NULL
       WHERE  hold_id = $1
         AND  status  = 'held'
       RETURNING id`,
      [holdId]
    );

    // 3. Remove the hold record
    await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

    releasedSeats = seats.map((s) => ({ id: s.id, status: 'available' }));
  });

  if (releasedSeats.length > 0) broadcast('released', releasedSeats);

  return { released: releasedSeats.map((s) => s.id) };
}

/**
 * Periodic sweep: expire all stale holds and broadcast releases.
 * Called by setInterval in the server.
 */
export async function sweepExpiredHolds(db) {
  try {
    const released = await expireStaleHolds(db);
    if (released.length > 0) broadcast('released', released);
  } catch (err) {
    console.error('[sweep] Error expiring holds:', err.message);
  }
}
