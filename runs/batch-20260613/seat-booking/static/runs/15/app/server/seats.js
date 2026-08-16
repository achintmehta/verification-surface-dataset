import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcastSeatChanges } from './sse.js';

// All mutating operations run inside a single Promise chain (mutex) so that
// even though PGLite is single-engine, our multi-statement transactions are
// not interleaved at the application level. Combined with explicit SQL
// transactions, this guarantees atomic check-and-set of seat state.
let queue = Promise.resolve();

function withLock(fn) {
  // Chain onto the queue regardless of whether the previous task resolved or
  // rejected, so a failed operation never breaks the mutex.
  const run = queue.then(
    () => fn(),
    () => fn()
  );
  // Keep the chain alive and swallow this task's outcome for the *next* waiter,
  // while still returning the real result/rejection to the caller.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---- Errors ---------------------------------------------------------------

export class ConflictError extends Error {
  constructor(message, conflicts) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.conflicts = conflicts;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export class GoneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoneError';
    this.statusCode = 410;
  }
}

// ---- Helpers --------------------------------------------------------------

// Map a raw DB seat row to the effective representation sent to clients.
// A held seat whose hold has expired is reported as available.
function effectiveSeat(row, nowMs) {
  let status = row.status;
  if (
    status === 'held' &&
    row.hold_expires_at &&
    new Date(row.hold_expires_at).getTime() <= nowMs
  ) {
    status = 'available';
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
  };
}

// Release any expired holds inside the given DB/transaction handle.
// Returns the list of seat ids that were freed so callers can broadcast.
async function releaseExpired(tx) {
  // Mark expired holds first.
  await tx.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  // Free seats whose hold has expired. Returns affected rows.
  const { rows } = await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()
      RETURNING id, row_label, seat_number, status, hold_expires_at`
  );
  return rows.map((r) => effectiveSeat(r, Date.now()));
}

// ---- Public API -----------------------------------------------------------

// Read all seats with their effective status. Performs lazy expiry and
// broadcasts any releases that resulted.
export async function getSeats() {
  return withLock(async () => {
    const db = await getDb();
    let freed = [];
    await db.transaction(async (tx) => {
      freed = await releaseExpired(tx);
    });
    if (freed.length) broadcastSeatChanges(freed);

    const { rows } = await db.query(
      `SELECT id, row_label, seat_number, status, hold_expires_at
         FROM seats ORDER BY row_label, seat_number`
    );
    const now = Date.now();
    return rows.map((r) => effectiveSeat(r, now));
  });
}

// Atomically acquire ALL requested seats for a session, or none of them.
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new ValidationError('seatIds must be a non-empty array');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ValidationError('sessionId is required');
  }
  // Deduplicate requested seats.
  const requested = [...new Set(seatIds)];

  return withLock(async () => {
    const db = await getDb();
    let result;
    let freedBefore = [];
    let acquiredSeats = [];

    await db.transaction(async (tx) => {
      // Enforce expiry before evaluating availability.
      freedBefore = await releaseExpired(tx);

      // Verify every requested seat exists.
      const { rows: existing } = await tx.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id = ANY($1::text[])`,
        [requested]
      );
      const found = new Set(existing.map((r) => r.id));
      const missing = requested.filter((id) => !found.has(id));
      if (missing.length) {
        throw new NotFoundError(`Unknown seat(s): ${missing.join(', ')}`);
      }

      // Atomic conditional acquisition: only flip seats that are currently
      // available (post-expiry). If we cannot acquire all of them, the
      // transaction is rolled back and nobody acquires anything.
      const holdId = randomUUID();
      const { rows: updated } = await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1,
                hold_expires_at = now() + ($2::int * interval '1 millisecond')
          WHERE id = ANY($3::text[])
            AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_expires_at`,
        [holdId, HOLD_TTL_MS, requested]
      );

      if (updated.length !== requested.length) {
        // Some seats were not available. Determine the conflicting ones.
        const acquired = new Set(updated.map((r) => r.id));
        const conflicts = requested.filter((id) => !acquired.has(id));
        // Roll back by throwing; PGLite will discard the partial update.
        throw new ConflictError('Some seats are no longer available', conflicts);
      }

      // Record the hold.
      const expiresRow = updated[0].hold_expires_at;
      await tx.query(
        `INSERT INTO holds (id, session_id, status, expires_at)
         VALUES ($1, $2, 'active', $3)`,
        [holdId, sessionId, expiresRow]
      );

      acquiredSeats = updated.map((r) => effectiveSeat(r, Date.now()));
      result = {
        holdId,
        sessionId,
        seatIds: requested,
        expiresAt: new Date(expiresRow).toISOString(),
        ttlMs: HOLD_TTL_MS,
      };
    });

    // Broadcast outside the transaction.
    if (freedBefore.length) broadcastSeatChanges(freedBefore);
    if (acquiredSeats.length) broadcastSeatChanges(acquiredSeats);
    return result;
  });
}

// Confirm a hold: book its seats. Idempotent.
export async function confirmHold(holdId) {
  if (typeof holdId !== 'string' || holdId.trim() === '') {
    throw new ValidationError('holdId is required');
  }

  return withLock(async () => {
    const db = await getDb();
    let booked = [];
    let result;

    await db.transaction(async (tx) => {
      // Enforce expiry first so an expired hold cannot be confirmed.
      await releaseExpired(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, status, expires_at FROM holds WHERE id = $1`,
        [holdId]
      );
      if (holdRows.length === 0) {
        throw new NotFoundError('Unknown hold');
      }
      const hold = holdRows[0];

      // Idempotency: a confirmed hold returns its existing booking.
      if (hold.status === 'confirmed') {
        const { rows: seatRows } = await tx.query(
          `SELECT id, row_label, seat_number, status FROM seats
             WHERE booked_by = $1 ORDER BY row_label, seat_number`,
          [holdId]
        );
        result = {
          holdId,
          sessionId: hold.session_id,
          status: 'confirmed',
          seatIds: seatRows.map((r) => r.id),
          alreadyConfirmed: true,
        };
        return;
      }

      if (hold.status === 'expired' || hold.status === 'released') {
        throw new GoneError(`Hold is ${hold.status}; nothing was booked`);
      }

      // Active hold but double-check expiry by wall clock as a safety net.
      if (new Date(hold.expires_at).getTime() <= Date.now()) {
        await releaseExpired(tx);
        throw new GoneError('Hold has expired; nothing was booked');
      }

      // Book exactly the seats still owned by this hold.
      const { rows: bookedRows } = await tx.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1,
                hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number, status`,
        [holdId]
      );

      if (bookedRows.length === 0) {
        // The hold owns no held seats (race / already released).
        throw new GoneError('Hold no longer owns any seats; nothing was booked');
      }

      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      booked = bookedRows.map((r) => ({
        id: r.id,
        row: r.row_label,
        number: r.seat_number,
        status: 'booked',
      }));
      result = {
        holdId,
        sessionId: hold.session_id,
        status: 'confirmed',
        seatIds: bookedRows.map((r) => r.id),
        alreadyConfirmed: false,
      };
    });

    if (booked.length) broadcastSeatChanges(booked);
    return result;
  });
}

// Release a hold early, returning its seats to available. Idempotent-ish:
// releasing an already-released/confirmed hold is a no-op success.
export async function releaseHold(holdId) {
  if (typeof holdId !== 'string' || holdId.trim() === '') {
    throw new ValidationError('holdId is required');
  }

  return withLock(async () => {
    const db = await getDb();
    let freed = [];
    let result;

    await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, status FROM holds WHERE id = $1`,
        [holdId]
      );
      if (holdRows.length === 0) {
        throw new NotFoundError('Unknown hold');
      }
      const hold = holdRows[0];

      if (hold.status === 'confirmed') {
        // Cannot release booked seats.
        throw new ConflictError('Hold is already confirmed; cannot release', []);
      }

      if (hold.status === 'active') {
        const { rows: freedRows } = await tx.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING id, row_label, seat_number, status`,
          [holdId]
        );
        freed = freedRows.map((r) => ({
          id: r.id,
          row: r.row_label,
          number: r.seat_number,
          status: 'available',
        }));
        await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
      }

      result = { holdId, status: 'released', seatIds: freed.map((s) => s.id) };
    });

    if (freed.length) broadcastSeatChanges(freed);
    return result;
  });
}

// Background sweep: release stale holds and broadcast. Returns freed count.
export async function sweepExpired() {
  return withLock(async () => {
    const db = await getDb();
    let freed = [];
    await db.transaction(async (tx) => {
      freed = await releaseExpired(tx);
    });
    if (freed.length) broadcastSeatChanges(freed);
    return freed.length;
  });
}

// Inventory snapshot for diagnostics / tests.
export async function getInventory() {
  await getSeats(); // triggers expiry
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
  );
  const inv = { available: 0, held: 0, booked: 0 };
  for (const r of rows) inv[r.status] = r.count;
  inv.total = inv.available + inv.held + inv.booked;
  return inv;
}
