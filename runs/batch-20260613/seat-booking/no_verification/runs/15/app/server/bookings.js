import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { config } from './config.js';
import { broadcastSeatUpdates } from './sse.js';

/**
 * Shape a seat row for API/SSE consumption. Always reflects the *effective*
 * status (held seats whose hold has expired are treated as available).
 */
function shapeSeat(row) {
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status: row.status,
    holdId: row.hold_id || null,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null,
    bookedBy: row.booked_by || null
  };
}

/**
 * Release every hold whose expires_at is in the past. Runs inside a single
 * transaction so the read + write of expired seats is atomic. Returns the
 * list of seats that transitioned back to available (for broadcasting).
 */
export async function expireStaleHolds() {
  const db = getDb();
  let released = [];

  await db.transaction(async (tx) => {
    // Find seats currently held but whose hold has lapsed.
    const { rows } = await tx.query(
      `UPDATE seats
          SET status = 'available',
              hold_id = NULL,
              hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= now()
        RETURNING *`
    );
    released = rows;

    // Mark the corresponding holds as expired.
    await tx.query(
      `UPDATE holds
          SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= now()`
    );
  });

  const updates = released.map(shapeSeat);
  broadcastSeatUpdates(updates);
  return updates;
}

/**
 * Return the full seat map with effective status. Expires stale holds first.
 */
export async function getSeats() {
  await expireStaleHolds();
  const db = getDb();
  const { rows } = await db.query(
    'SELECT * FROM seats ORDER BY row_label, seat_number'
  );
  return rows.map(shapeSeat);
}

/**
 * Atomically acquire ALL requested seats for a session, all-or-nothing.
 *
 * On success: creates a hold, marks the seats held, returns { hold, seats }.
 * On conflict: throws an error with `.statusCode = 409` and `.conflicts`
 * listing the seat ids that were unavailable. No seats are modified.
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.statusCode = 400;
    throw err;
  }
  if (!sessionId || typeof sessionId !== 'string') {
    const err = new Error('sessionId is required');
    err.statusCode = 400;
    throw err;
  }

  // Normalise to unique integer ids.
  const ids = [...new Set(seatIds.map((n) => Number(n)))];
  if (ids.some((n) => !Number.isInteger(n))) {
    const err = new Error('seatIds must be integers');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + config.holdTtlMs);

  let result = null;
  let conflicts = null;

  await db.transaction(async (tx) => {
    // First, release any holds that have already expired so those seats are
    // acquirable in this same transaction (consistent snapshot).
    await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= now()`
    );

    // Lock the requested seats so concurrent transactions serialise here.
    const { rows: locked } = await tx.query(
      `SELECT * FROM seats WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [ids]
    );

    // Verify all requested seats exist.
    const foundIds = new Set(locked.map((r) => r.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      conflicts = missing;
      const err = new Error('Unknown seat ids');
      err.statusCode = 404;
      err.conflicts = missing;
      throw err;
    }

    // Determine which seats are NOT available right now.
    const unavailable = locked
      .filter((r) => r.status !== 'available')
      .map((r) => r.id);

    if (unavailable.length > 0) {
      conflicts = unavailable;
      const err = new Error('One or more seats are no longer available');
      err.statusCode = 409;
      err.conflicts = unavailable;
      throw err; // rolls back: no seats acquired (all-or-nothing)
    }

    // All seats available -> create the hold and mark them held atomically.
    await tx.query(
      `INSERT INTO holds (hold_id, session_id, expires_at, status)
       VALUES ($1, $2, $3, 'active')`,
      [holdId, sessionId, expiresAt.toISOString()]
    );

    const { rows: updated } = await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
        WHERE id = ANY($3::int[])
        RETURNING *`,
      [holdId, expiresAt.toISOString(), ids]
    );

    result = {
      hold: {
        holdId,
        sessionId,
        seatIds: ids,
        expiresAt: expiresAt.toISOString(),
        status: 'active',
        ttlMs: config.holdTtlMs
      },
      seats: updated.map(shapeSeat)
    };
  });

  if (result) {
    broadcastSeatUpdates(result.seats);
  }
  return result;
}

/**
 * Confirm a hold: book its seats permanently. Idempotent — confirming an
 * already-confirmed hold returns the same booking and books nothing more.
 *
 * Throws statusCode 410 for expired holds, 404 for unknown holds.
 */
export async function confirmHold(holdId, sessionId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  let result = null;
  let broadcastSeats = [];

  await db.transaction(async (tx) => {
    // Lock the hold row to serialise concurrent confirms of the same hold.
    const { rows: holdRows } = await tx.query(
      'SELECT * FROM holds WHERE hold_id = $1 FOR UPDATE',
      [holdId]
    );

    if (holdRows.length === 0) {
      const err = new Error('Unknown hold');
      err.statusCode = 404;
      throw err;
    }

    const hold = holdRows[0];

    // Optional ownership enforcement: a hold can only be confirmed by its owner.
    if (sessionId && hold.session_id !== sessionId) {
      const err = new Error('Hold belongs to a different session');
      err.statusCode = 403;
      throw err;
    }

    // Idempotency: already confirmed -> return existing booking, book nothing.
    if (hold.status === 'confirmed') {
      const { rows: bookedSeats } = await tx.query(
        'SELECT * FROM seats WHERE hold_id = $1 ORDER BY id',
        [holdId]
      );
      result = {
        hold: {
          holdId,
          sessionId: hold.session_id,
          status: 'confirmed',
          confirmedAt: hold.confirmed_at ? new Date(hold.confirmed_at).toISOString() : null
        },
        seats: bookedSeats.map(shapeSeat),
        alreadyConfirmed: true
      };
      return; // commit (no changes)
    }

    // Released holds cannot be confirmed.
    if (hold.status === 'released') {
      const err = new Error('Hold was released');
      err.statusCode = 410;
      throw err;
    }

    // Expiry check: a hold past its TTL (or already marked expired) fails and
    // books nothing. Release its seats here as part of enforcement.
    const { rows: nowRows } = await tx.query('SELECT now() AS now');
    const now = new Date(nowRows[0].now).getTime();
    const expiresAt = new Date(hold.expires_at).getTime();

    if (hold.status === 'expired' || expiresAt <= now) {
      // Release the seats this expired hold still occupies.
      const { rows: releasedSeats } = await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING *`,
        [holdId]
      );
      await tx.query(
        `UPDATE holds SET status = 'expired' WHERE hold_id = $1`,
        [holdId]
      );
      broadcastSeats = releasedSeats.map(shapeSeat);

      const err = new Error('Hold has expired');
      err.statusCode = 410;
      throw err;
    }

    // Active and valid -> book the seats it currently holds.
    const { rows: bookedSeats } = await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
        WHERE hold_id = $2 AND status = 'held'
        RETURNING *`,
      [hold.session_id, holdId]
    );

    if (bookedSeats.length === 0) {
      // Defensive: hold active but owns no held seats (should not normally happen).
      const err = new Error('Hold owns no seats to confirm');
      err.statusCode = 409;
      throw err;
    }

    const confirmedAt = new Date();
    await tx.query(
      `UPDATE holds SET status = 'confirmed', confirmed_at = $1 WHERE hold_id = $2`,
      [confirmedAt.toISOString(), holdId]
    );

    result = {
      hold: {
        holdId,
        sessionId: hold.session_id,
        status: 'confirmed',
        confirmedAt: confirmedAt.toISOString()
      },
      seats: bookedSeats.map(shapeSeat),
      alreadyConfirmed: false
    };
    broadcastSeats = bookedSeats.map(shapeSeat);
  });

  if (broadcastSeats.length > 0) {
    broadcastSeatUpdates(broadcastSeats);
  }
  return result;
}

/**
 * Release a hold early: its held seats become available again. Idempotent.
 * Confirmed holds cannot be released (their seats are booked).
 */
export async function releaseHold(holdId, sessionId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  let releasedSeats = [];
  let status = 'released';

  await db.transaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      'SELECT * FROM holds WHERE hold_id = $1 FOR UPDATE',
      [holdId]
    );

    if (holdRows.length === 0) {
      const err = new Error('Unknown hold');
      err.statusCode = 404;
      throw err;
    }

    const hold = holdRows[0];

    if (sessionId && hold.session_id !== sessionId) {
      const err = new Error('Hold belongs to a different session');
      err.statusCode = 403;
      throw err;
    }

    if (hold.status === 'confirmed') {
      const err = new Error('Cannot release a confirmed (booked) hold');
      err.statusCode = 409;
      throw err;
    }

    const { rows } = await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING *`,
      [holdId]
    );
    releasedSeats = rows;
    status = hold.status === 'expired' ? 'expired' : 'released';

    await tx.query(
      `UPDATE holds SET status = $2 WHERE hold_id = $1`,
      [holdId, 'released']
    );
  });

  const updates = releasedSeats.map(shapeSeat);
  broadcastSeatUpdates(updates);
  return { holdId, status, seats: updates };
}

/**
 * Return inventory counts. Expires stale holds first so counts are exact.
 */
export async function getInventory() {
  await expireStaleHolds();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available,
        COUNT(*) FILTER (WHERE status = 'held')::int AS held,
        COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
     FROM seats`
  );
  return rows[0];
}
