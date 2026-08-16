import { randomUUID } from 'node:crypto';
import { getDb, HOLD_TTL_MS } from './db.js';
import { broadcastSeatChanges } from './sse.js';

// A process-local mutex serializes all state-mutating seat operations.
// PGlite runs a single embedded Postgres; serializing the check-and-set
// critical sections guarantees that two concurrent hold requests for the
// same seat can never both succeed (all-or-nothing acquisition).
let opChain = Promise.resolve();
function withLock(fn) {
  const run = opChain.then(fn, fn);
  // Keep the chain alive even if fn rejects.
  opChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Release any holds whose expires_at is in the past. Returns the list of
 * seat changes produced (so the caller can broadcast them).
 * Must be called inside the lock for mutating ops; for read endpoints it is
 * also safe because it is itself atomic via a single SQL statement chain.
 */
async function expireStaleHolds(db) {
  // Mark expired holds.
  await db.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  // Free seats that belong to a hold that is no longer active.
  const { rows } = await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND (hold_expires_at IS NULL OR hold_expires_at <= now()
             OR hold_id NOT IN (SELECT id FROM holds WHERE status = 'active'))
      RETURNING id, row_label, seat_number, status, hold_expires_at`
  );

  return rows.map(serializeSeat);
}

function serializeSeat(s) {
  return {
    id: s.id,
    row: s.row_label,
    number: s.seat_number,
    status: s.status,
    holdExpiresAt: s.hold_expires_at
      ? new Date(s.hold_expires_at).toISOString()
      : null,
    holdId: s.hold_id ?? null,
  };
}

/**
 * Return all seats with their effective current status. Seats whose hold has
 * expired are reported (and persisted) as available. Broadcasts any releases.
 */
export async function getSeats() {
  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);
    if (released.length) broadcastSeatChanges(released);

    const { rows } = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats ORDER BY id`
    );
    return rows.map(serializeSeat);
  });
}

/**
 * Atomically acquire ALL requested seats for a session.
 * Returns { hold } on success or throws a ConflictError with conflicting ids.
 */
export class ConflictError extends Error {
  constructor(conflicts) {
    super('Some requested seats are unavailable');
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new BadRequestError('seatIds must be a non-empty array');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new BadRequestError('sessionId is required');
  }

  // De-duplicate and coerce to integers.
  const ids = [...new Set(seatIds.map((x) => Number(x)))];
  if (ids.some((x) => !Number.isInteger(x))) {
    throw new BadRequestError('seatIds must be integers');
  }

  return withLock(async () => {
    const db = getDb();

    // First, free any stale holds so previously-expired seats are available.
    const released = await expireStaleHolds(db);

    const holdId = randomUUID();
    const ttlMs = HOLD_TTL_MS;

    let result;
    try {
      await db.exec('BEGIN');

      // Check current availability of every requested seat.
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows: current } = await db.query(
        `SELECT id, status, hold_expires_at, hold_id
           FROM seats WHERE id IN (${placeholders})`,
        ids
      );

      // Detect missing seat ids.
      const found = new Set(current.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        await db.exec('ROLLBACK');
        throw new BadRequestError(`Unknown seat ids: ${missing.join(', ')}`);
      }

      // A seat is unavailable if it is booked, or held by a still-active hold.
      const conflicts = current
        .filter((r) => r.status !== 'available')
        .map((r) => r.id);

      if (conflicts.length) {
        await db.exec('ROLLBACK');
        throw new ConflictError(conflicts);
      }

      // Create the hold record.
      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 'active')`,
        [holdId, sessionId, String(ttlMs)]
      );

      // Atomically mark all seats held — only if still available.
      // Parameters: $1 = holdId, $2..$(n+1) = seat ids.
      const updatePlaceholders = ids.map((_, i) => `$${i + 2}`).join(',');
      const { rows: updated } = await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1,
                hold_expires_at = (SELECT expires_at FROM holds WHERE id = $1)
          WHERE id IN (${updatePlaceholders})
            AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at`,
        [holdId, ...ids]
      );

      // Guard: if we couldn't grab all of them, abort entirely.
      if (updated.length !== ids.length) {
        await db.exec('ROLLBACK');
        const grabbed = new Set(updated.map((r) => r.id));
        const conflicts2 = ids.filter((id) => !grabbed.has(id));
        throw new ConflictError(conflicts2);
      }

      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at FROM holds WHERE id = $1`,
        [holdId]
      );

      await db.exec('COMMIT');

      result = {
        changes: updated.map(serializeSeat),
        hold: {
          holdId,
          sessionId,
          seatIds: ids,
          expiresAt: new Date(holdRows[0].expires_at).toISOString(),
          ttlMs,
        },
      };
    } catch (err) {
      // Ensure transaction is not left open.
      try { await db.exec('ROLLBACK'); } catch { /* already closed */ }
      // Broadcast any releases we discovered before failing.
      if (released.length) broadcastSeatChanges(released);
      throw err;
    }

    // Broadcast releases first, then the new holds.
    if (released.length) broadcastSeatChanges(released);
    broadcastSeatChanges(result.changes);

    return result.hold;
  });
}

/**
 * Confirm a hold: book all its seats. Idempotent — confirming twice books
 * exactly once and returns the same booking. Expired/unknown holds fail.
 */
export async function confirmHold(holdId, sessionId) {
  if (!holdId) throw new BadRequestError('holdId is required');

  return withLock(async () => {
    const db = getDb();

    // Expire stale holds first (but capture so we can still detect this one).
    const released = await expireStaleHolds(db);

    let result;
    try {
      await db.exec('BEGIN');

      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, status, expires_at FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK');
        if (released.length) broadcastSeatChanges(released);
        throw new BadRequestError('Unknown hold');
      }

      const hold = holdRows[0];

      // Idempotent: already confirmed -> return existing booking, change nothing.
      if (hold.status === 'confirmed') {
        const { rows: booked } = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats WHERE hold_id = $1 ORDER BY id`,
          [holdId]
        );
        await db.exec('COMMIT');
        if (released.length) broadcastSeatChanges(released);
        return {
          holdId,
          status: 'confirmed',
          alreadyConfirmed: true,
          seatIds: booked.map((r) => r.id),
        };
      }

      // Reject expired / released holds.
      const { rows: expCheck } = await db.query(
        `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1`,
        [holdId]
      );
      if (hold.status !== 'active' || expCheck[0].expired) {
        await db.exec('ROLLBACK');
        if (released.length) broadcastSeatChanges(released);
        throw new BadRequestError('Hold is expired or no longer active');
      }

      // Re-validate ownership: the seats must still be held by THIS hold.
      const { rows: heldSeats } = await db.query(
        `SELECT id FROM seats
          WHERE hold_id = $1 AND status = 'held'
            AND (hold_expires_at IS NULL OR hold_expires_at > now())`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        await db.exec('ROLLBACK');
        if (released.length) broadcastSeatChanges(released);
        throw new BadRequestError('Hold no longer owns any seats');
      }

      const { rows: bookedSeats } = await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2,
                hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at`,
        [holdId, hold.session_id]
      );

      await db.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      await db.exec('COMMIT');

      result = {
        changes: bookedSeats.map(serializeSeat),
        response: {
          holdId,
          status: 'confirmed',
          alreadyConfirmed: false,
          seatIds: bookedSeats.map((r) => r.id),
        },
      };
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }

    if (released.length) broadcastSeatChanges(released);
    broadcastSeatChanges(result.changes);
    return result.response;
  });
}

/**
 * Release a hold early, returning its seats to available.
 */
export async function releaseHold(holdId) {
  if (!holdId) throw new BadRequestError('holdId is required');

  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);

    const { rows: holdRows } = await db.query(
      `SELECT id, status FROM holds WHERE id = $1`,
      [holdId]
    );
    if (holdRows.length === 0) {
      if (released.length) broadcastSeatChanges(released);
      throw new BadRequestError('Unknown hold');
    }
    if (holdRows[0].status === 'confirmed') {
      if (released.length) broadcastSeatChanges(released);
      throw new BadRequestError('Cannot release a confirmed hold');
    }

    const { rows: freed } = await db.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at`,
      [holdId]
    );
    await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    const allChanges = [...released, ...freed.map(serializeSeat)];
    if (allChanges.length) broadcastSeatChanges(allChanges);

    return { holdId, released: freed.map((r) => r.id) };
  });
}

/**
 * Periodic sweep used by a timer. Releases stale holds and broadcasts.
 */
export async function sweepExpired() {
  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);
    if (released.length) broadcastSeatChanges(released);
    return released;
  });
}

/**
 * Inventory summary for diagnostics / verification.
 */
export async function getInventory() {
  return withLock(async () => {
    const db = getDb();
    await expireStaleHolds(db);
    const { rows } = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
    );
    const inv = { available: 0, held: 0, booked: 0 };
    for (const r of rows) inv[r.status] = r.count;
    inv.total = inv.available + inv.held + inv.booked;
    return inv;
  });
}
