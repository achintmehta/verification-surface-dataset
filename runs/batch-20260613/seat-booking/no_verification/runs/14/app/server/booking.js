import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { config } from './config.js';
import { broadcastSeatChanges } from './sse.js';

/**
 * Map a raw DB seat row to its effective public representation.
 * A held seat whose hold has expired is reported as available.
 */
function toEffectiveSeat(row, nowMs) {
  let status = row.status;
  let holdId = row.hold_id;
  let holdExpiresAt = row.hold_expires_at;
  let bookedBy = row.booked_by;

  if (status === 'held') {
    const expMs = holdExpiresAt ? new Date(holdExpiresAt).getTime() : 0;
    if (!expMs || expMs <= nowMs) {
      // Effectively expired -> available.
      status = 'available';
      holdId = null;
      holdExpiresAt = null;
    }
  }

  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status,
    holdId: status === 'held' ? holdId : null,
    holdExpiresAt: status === 'held' ? holdExpiresAt : null,
    bookedBy: status === 'booked' ? bookedBy : null,
  };
}

/**
 * Release all holds whose expires_at is in the past. This mutates seat rows
 * back to available and marks the hold rows expired. Runs in its own
 * transaction. Returns the list of effective seats that changed so callers
 * can broadcast them.
 */
export async function sweepExpired() {
  const db = getDb();
  let changed = [];

  await db.transaction(async (tx) => {
    // Find seats whose hold has expired.
    const { rows: expiredSeats } = await tx.query(
      `SELECT * FROM seats
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= now()
        FOR UPDATE;`
    );

    if (expiredSeats.length === 0) return;

    await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= now();`
    );

    // Mark the affected holds expired.
    await tx.query(
      `UPDATE holds
          SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= now();`
    );

    const nowMs = Date.now();
    changed = expiredSeats.map((r) =>
      toEffectiveSeat({ ...r, status: 'available', hold_id: null, hold_expires_at: null }, nowMs)
    );
  });

  if (changed.length > 0) {
    broadcastSeatChanges(changed);
  }
  return changed;
}

/**
 * Return all seats with their effective status. Performs expiry as a side
 * effect (broadcasting releases) before reading.
 */
export async function getSeats() {
  await sweepExpired();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT * FROM seats ORDER BY row_label, seat_number;`
  );
  const nowMs = Date.now();
  return rows.map((r) => toEffectiveSeat(r, nowMs));
}

/**
 * Atomically acquire ALL requested seats for a session. All-or-nothing:
 * if any requested seat is not currently available (after expiry handling),
 * acquire none and throw a ConflictError with the conflicting seat ids.
 *
 * @returns {{ holdId, expiresAt, seats }}
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

  // De-duplicate requested seat ids.
  const requested = [...new Set(seatIds)];
  const db = getDb();

  const holdId = randomUUID();
  const expiresAtMs = Date.now() + config.holdTtlMs;
  const expiresAt = new Date(expiresAtMs).toISOString();

  let result = null;
  let conflicts = null;
  let releasedDuringSweep = [];

  await db.transaction(async (tx) => {
    // First, within the same transaction, free any expired holds so the
    // availability check sees the true current state. Lock affected rows.
    const { rows: expiredRows } = await tx.query(
      `SELECT id FROM seats
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= now()
        FOR UPDATE;`
    );
    if (expiredRows.length > 0) {
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE status = 'held'
            AND hold_expires_at IS NOT NULL
            AND hold_expires_at <= now();`
      );
      await tx.query(
        `UPDATE holds SET status = 'expired'
          WHERE status = 'active' AND expires_at <= now();`
      );
      releasedDuringSweep = expiredRows.map((r) => r.id);
    }

    // Lock the requested seat rows to serialize concurrent acquisitions.
    const placeholders = requested.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: lockedSeats } = await tx.query(
      `SELECT * FROM seats WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE;`,
      requested
    );

    // Verify every requested seat exists.
    const found = new Set(lockedSeats.map((s) => s.id));
    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      const err = new Error('Unknown seat id(s): ' + missing.join(', '));
      err.statusCode = 400;
      throw err;
    }

    // Determine effective availability (held-but-expired counts as available).
    const nowMs = Date.now();
    const unavailable = [];
    for (const s of lockedSeats) {
      const eff = toEffectiveSeat(s, nowMs);
      if (eff.status !== 'available') {
        unavailable.push(s.id);
      }
    }

    if (unavailable.length > 0) {
      conflicts = unavailable;
      const err = new Error('Conflict');
      err.statusCode = 409;
      err.conflicts = unavailable;
      throw err;
    }

    // All available -> create the hold and mark every seat held.
    await tx.query(
      `INSERT INTO holds (id, session_id, expires_at, status)
       VALUES ($1, $2, $3, 'active');`,
      [holdId, sessionId, expiresAt]
    );

    // Re-build placeholders offset by 2 because $1 and $2 are hold params.
    const updPlaceholders = requested.map((_, i) => `$${i + 3}`).join(', ');
    await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
        WHERE id IN (${updPlaceholders});`,
      [holdId, expiresAt, ...requested]
    );

    const { rows: updated } = await tx.query(
      `SELECT * FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number;`,
      [holdId]
    );

    result = {
      holdId,
      sessionId,
      expiresAt,
      seats: updated.map((r) => toEffectiveSeat(r, Date.now())),
    };
  });

  // Broadcast any releases discovered during the in-transaction sweep.
  if (releasedDuringSweep.length > 0) {
    const db2 = getDb();
    const placeholders = releasedDuringSweep.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await db2.query(
      `SELECT * FROM seats WHERE id IN (${placeholders});`,
      releasedDuringSweep
    );
    // Only broadcast those still available (not re-held by this txn).
    const stillAvailable = rows.filter((r) => !result || !result.seats.some((s) => s.id === r.id));
    broadcastSeatChanges(stillAvailable.map((r) => toEffectiveSeat(r, Date.now())));
  }

  // Broadcast the newly-held seats.
  broadcastSeatChanges(result.seats);
  return result;
}

/**
 * Confirm a hold within a single transaction. Idempotent: confirming an
 * already-confirmed hold returns the same booking without booking anything
 * additional. Rejects expired or unknown holds (books nothing).
 *
 * The whole booking decision and mutation happen inside ONE transaction so a
 * commit means "booked", and a rollback means "nothing changed". When we detect
 * an expired-but-active hold, we release its seats and commit that release in
 * the same transaction, then signal the caller to respond with an error.
 *
 * @returns {{ holdId, status: 'confirmed', seats }}
 */
export async function confirmHold(holdId, sessionId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  let result = null;
  let expiredRelease = null; // { message, statusCode, releasedSeats }

  await db.transaction(async (tx) => {
    // Lock the hold row.
    const { rows: holdRows } = await tx.query(
      `SELECT * FROM holds WHERE id = $1 FOR UPDATE;`,
      [holdId]
    );

    if (holdRows.length === 0) {
      const err = new Error('Unknown hold');
      err.statusCode = 404;
      throw err;
    }

    const hold = holdRows[0];

    // Idempotency: already confirmed -> return existing booking, book nothing.
    if (hold.status === 'confirmed') {
      const { rows: seats } = await tx.query(
        `SELECT * FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number;`,
        [holdId]
      );
      result = {
        holdId,
        status: 'confirmed',
        idempotent: true,
        seats: seats.map((r) => toEffectiveSeat(r, Date.now())),
      };
      return;
    }

    if (hold.status === 'released') {
      const err = new Error('Hold was released');
      err.statusCode = 409;
      throw err;
    }

    if (hold.status === 'expired') {
      const err = new Error('Hold has expired');
      err.statusCode = 409;
      throw err;
    }

    // status === 'active'. Re-validate expiry inside the transaction.
    const expMs = new Date(hold.expires_at).getTime();
    if (expMs <= Date.now()) {
      // Expire it now: release its seats and mark hold expired. This mutation
      // is allowed to COMMIT (we do not throw out of the transaction), but we
      // record that the confirm itself failed so the API returns 409.
      const { rows: seatRows } = await tx.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE;`,
        [holdId]
      );
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );
      await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1;`, [holdId]);

      expiredRelease = {
        statusCode: 409,
        message: 'Hold has expired',
        releasedSeats: seatRows.map((r) =>
          toEffectiveSeat(
            { ...r, status: 'available', hold_id: null, hold_expires_at: null },
            Date.now()
          )
        ),
      };
      return; // commit the release
    }

    // Optional ownership check.
    if (sessionId && hold.session_id !== sessionId) {
      const err = new Error('Hold belongs to a different session');
      err.statusCode = 403;
      throw err;
    }

    // Lock the seats and ensure they are still held by this hold.
    const { rows: seatRows } = await tx.query(
      `SELECT * FROM seats WHERE hold_id = $1 FOR UPDATE;`,
      [holdId]
    );

    const ownedHeld = seatRows.filter((s) => s.status === 'held');
    if (ownedHeld.length === 0) {
      const err = new Error('Hold owns no held seats');
      err.statusCode = 409;
      throw err;
    }

    // Book the seats.
    await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
        WHERE hold_id = $2 AND status = 'held';`,
      [hold.session_id, holdId]
    );
    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1;`, [holdId]);

    const { rows: finalSeats } = await tx.query(
      `SELECT * FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number;`,
      [holdId]
    );

    result = {
      holdId,
      status: 'confirmed',
      idempotent: false,
      seats: finalSeats.map((r) => toEffectiveSeat(r, Date.now())),
    };
  });

  // The transaction committed. If the hold had expired, broadcast its released
  // seats and surface the error to the caller.
  if (expiredRelease) {
    if (expiredRelease.releasedSeats.length > 0) {
      broadcastSeatChanges(expiredRelease.releasedSeats);
    }
    const err = new Error(expiredRelease.message);
    err.statusCode = expiredRelease.statusCode;
    throw err;
  }

  // Broadcast booked seats (only on a real, non-idempotent booking, but
  // broadcasting idempotent booked state is harmless and keeps clients fresh).
  if (result && !result.idempotent) {
    broadcastSeatChanges(result.seats);
  }
  return result;
}

/**
 * Release a hold early, returning its seats to available. Idempotent-ish:
 * releasing an already-confirmed hold is rejected (seats are booked).
 */
export async function releaseHold(holdId, sessionId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  let released = [];

  await db.transaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT * FROM holds WHERE id = $1 FOR UPDATE;`,
      [holdId]
    );

    if (holdRows.length === 0) {
      const err = new Error('Unknown hold');
      err.statusCode = 404;
      throw err;
    }

    const hold = holdRows[0];

    if (hold.status === 'confirmed') {
      const err = new Error('Hold already confirmed; seats are booked');
      err.statusCode = 409;
      throw err;
    }

    if (sessionId && hold.session_id !== sessionId) {
      const err = new Error('Hold belongs to a different session');
      err.statusCode = 403;
      throw err;
    }

    // Already released/expired -> nothing to do, idempotent success.
    if (hold.status !== 'active') {
      return;
    }

    const { rows: seatRows } = await tx.query(
      `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE;`,
      [holdId]
    );

    await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held';`,
      [holdId]
    );
    await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1;`, [holdId]);

    released = seatRows.map((r) =>
      toEffectiveSeat({ ...r, status: 'available', hold_id: null, hold_expires_at: null }, Date.now())
    );
  });

  if (released.length > 0) {
    broadcastSeatChanges(released);
  }
  return { holdId, status: 'released', seats: released };
}

/**
 * Compute exact inventory counts. Performs expiry first.
 */
export async function getInventory() {
  await sweepExpired();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'available')::int AS available,
        COUNT(*) FILTER (WHERE status = 'held')::int      AS held,
        COUNT(*) FILTER (WHERE status = 'booked')::int    AS booked,
        COUNT(*)::int                                     AS total
       FROM seats;`
  );
  return rows[0];
}
