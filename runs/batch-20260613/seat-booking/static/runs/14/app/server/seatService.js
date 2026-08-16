import { randomUUID } from 'node:crypto';
import { getDb, transaction } from './db.js';
import { broadcastSeatUpdates } from './sse.js';
import { HOLD_TTL_MS } from './config.js';

// Effective status normalizes a row: a seat marked 'held' whose hold has
// expired is effectively 'available'. Booked seats stay booked.
function effectiveStatus(row, nowMs) {
  if (row.status === 'held') {
    const exp = row.hold_expires_at ? new Date(row.hold_expires_at).getTime() : 0;
    if (exp <= nowMs) return 'available';
    return 'held';
  }
  return row.status;
}

function toClientSeat(row, nowMs) {
  const status = effectiveStatus(row, nowMs);
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdExpiresAt:
      status === 'held' && row.hold_expires_at
        ? new Date(row.hold_expires_at).toISOString()
        : null,
  };
}

// Release any held seats whose holds have expired. Runs inside `client`'s
// transaction (caller must already be inside a transaction). Returns the
// affected seat rows (post-release) so the caller can broadcast.
async function releaseExpiredWithin(client) {
  // Mark expired holds.
  await client.query(
    `UPDATE holds SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now()`
  );

  // Free seats whose hold expired. We free seats that are held but whose
  // hold_expires_at is in the past (covers any drift / orphaned holds too).
  const { rows } = await client.query(
    `UPDATE seats
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE status = 'held' AND hold_expires_at <= now()
     RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`
  );
  return rows;
}

// Public: run a sweep in its own transaction and broadcast releases.
export async function sweepExpired() {
  const released = await transaction(async (client) => {
    return releaseExpiredWithin(client);
  });
  if (released.length > 0) {
    const nowMs = Date.now();
    broadcastSeatUpdates(released.map((r) => toClientSeat(r, nowMs)));
  }
  return released;
}

// Read the full seat map with effective statuses. Lazily release expired holds
// first so reads are always consistent and broadcast resulting releases.
export async function getSeatMap() {
  const released = await transaction(async (client) => {
    return releaseExpiredWithin(client);
  });
  if (released.length > 0) {
    const nowMs = Date.now();
    broadcastSeatUpdates(released.map((r) => toClientSeat(r, nowMs)));
  }

  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
     FROM seats
     ORDER BY row_label, seat_number`
  );
  const nowMs = Date.now();
  return rows.map((r) => toClientSeat(r, nowMs));
}

export class HoldConflictError extends Error {
  constructor(conflictingSeatIds) {
    super('One or more requested seats are not available');
    this.name = 'HoldConflictError';
    this.conflictingSeatIds = conflictingSeatIds;
  }
}

export class HoldError extends Error {
  constructor(message, code = 'HOLD_ERROR') {
    super(message);
    this.name = 'HoldError';
    this.code = code;
  }
}

// Atomically acquire ALL requested seats for a session. All-or-nothing.
// Returns { hold, seats }.
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new HoldError('seatIds must be a non-empty array', 'BAD_REQUEST');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new HoldError('sessionId is required', 'BAD_REQUEST');
  }
  // De-duplicate.
  const uniqueIds = [...new Set(seatIds)];

  const result = await transaction(async (client) => {
    // Always settle expired holds first so freshly-expired seats are eligible.
    await releaseExpiredWithin(client);

    // Lock and inspect the requested seats. ORDER BY for deterministic lock
    // ordering to avoid deadlocks; FOR UPDATE so concurrent transactions block.
    const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: targeted } = await client.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
       WHERE id IN (${placeholders})
       ORDER BY id
       FOR UPDATE`,
      uniqueIds
    );

    // Validate every requested seat exists.
    const foundIds = new Set(targeted.map((r) => r.id));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new HoldError(
        `Unknown seat id(s): ${missing.join(', ')}`,
        'BAD_REQUEST'
      );
    }

    // Determine effective availability (held-but-expired counts as available,
    // though we already released those above).
    const nowMs = Date.now();
    const conflicting = targeted
      .filter((r) => effectiveStatus(r, nowMs) !== 'available')
      .map((r) => r.id);

    if (conflicting.length > 0) {
      // All-or-nothing: acquire none.
      throw new HoldConflictError(conflicting);
    }

    // Create the hold.
    const holdId = randomUUID();
    const ttlMs = HOLD_TTL_MS;
    const { rows: holdRows } = await client.query(
      `INSERT INTO holds (id, session_id, expires_at, status)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 'active')
       RETURNING id, session_id, created_at, expires_at, status`,
      [holdId, sessionId, String(ttlMs)]
    );
    const hold = holdRows[0];

    // Mark all seats held under this hold.
    const { rows: updated } = await client.query(
      `UPDATE seats
       SET status = 'held', hold_id = $1, hold_expires_at = $2
       WHERE id IN (${placeholders})
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [holdId, hold.expires_at, ...uniqueIds]
    );

    return { hold, seats: updated };
  });

  const nowMs = Date.now();
  const clientSeats = result.seats.map((r) => toClientSeat(r, nowMs));
  broadcastSeatUpdates(clientSeats);

  return {
    hold: {
      id: result.hold.id,
      sessionId: result.hold.session_id,
      expiresAt: new Date(result.hold.expires_at).toISOString(),
      status: result.hold.status,
    },
    seats: clientSeats,
  };
}

// Confirm a hold: book its seats. Idempotent. Returns { hold, seats }.
export async function confirmHold(holdId) {
  const result = await transaction(async (client) => {
    // Settle expiries first (this may expire the very hold we're confirming
    // if its TTL has passed).
    await releaseExpiredWithin(client);

    const { rows: holdRows } = await client.query(
      `SELECT id, session_id, created_at, expires_at, status
       FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRows.length === 0) {
      throw new HoldError('Unknown hold', 'UNKNOWN_HOLD');
    }
    const hold = holdRows[0];

    // Idempotency: if already confirmed, return the seats booked under it.
    if (hold.status === 'confirmed') {
      const { rows: bookedSeats } = await client.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats WHERE hold_id = $1 ORDER BY id`,
        [holdId]
      );
      return { hold, seats: bookedSeats, alreadyConfirmed: true };
    }

    if (hold.status !== 'active') {
      // released or expired
      throw new HoldError(
        `Hold is ${hold.status} and cannot be confirmed`,
        'HOLD_NOT_ACTIVE'
      );
    }

    // Double-check expiry against the clock inside the transaction.
    const expMs = new Date(hold.expires_at).getTime();
    if (expMs <= Date.now()) {
      // Mark expired and release its seats; book nothing.
      await client.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [
        holdId,
      ]);
      const { rows: freed } = await client.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId]
      );
      const err = new HoldError('Hold has expired', 'HOLD_EXPIRED');
      err.freedSeats = freed;
      throw err;
    }

    // Verify the hold still owns its seats and they are held by this hold.
    const { rows: ownedSeats } = await client.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE`,
      [holdId]
    );

    if (ownedSeats.length === 0) {
      throw new HoldError('Hold owns no seats', 'HOLD_NOT_ACTIVE');
    }

    // Book them.
    const { rows: booked } = await client.query(
      `UPDATE seats
       SET status = 'booked', booked_by = $2, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [holdId, hold.session_id]
    );

    await client.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [
      holdId,
    ]);

    return { hold, seats: booked, alreadyConfirmed: false };
  });

  // Broadcast only when something newly transitioned. On idempotent re-confirm
  // there is no transition, but rebroadcasting is harmless and keeps clients
  // in sync. We broadcast in both cases.
  const nowMs = Date.now();
  const clientSeats = result.seats.map((r) => toClientSeat(r, nowMs));
  if (!result.alreadyConfirmed) {
    broadcastSeatUpdates(clientSeats);
  }

  return {
    booking: {
      holdId: result.hold.id,
      sessionId: result.hold.session_id,
      status: 'confirmed',
    },
    seats: clientSeats,
  };
}

// Release a hold early, returning its seats to available.
export async function releaseHold(holdId) {
  const result = await transaction(async (client) => {
    const { rows: holdRows } = await client.query(
      `SELECT id, status FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId]
    );
    if (holdRows.length === 0) {
      throw new HoldError('Unknown hold', 'UNKNOWN_HOLD');
    }
    const hold = holdRows[0];

    if (hold.status === 'confirmed') {
      throw new HoldError('Cannot release a confirmed hold', 'HOLD_CONFIRMED');
    }

    // Free its held seats (only ones still held by this hold).
    const { rows: freed } = await client.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [holdId]
    );

    await client.query(
      `UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`,
      [holdId]
    );

    return freed;
  });

  if (result.length > 0) {
    const nowMs = Date.now();
    broadcastSeatUpdates(result.map((r) => toClientSeat(r, nowMs)));
  }
  return result.map((r) => toClientSeat(r, Date.now()));
}

// Inventory summary for diagnostics / acceptance checks.
export async function getInventory() {
  await sweepExpired();
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, status, hold_expires_at FROM seats`
  );
  const nowMs = Date.now();
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const r of rows) {
    const s = effectiveStatus(r, nowMs);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else if (s === 'booked') booked++;
  }
  return { available, held, booked, total: rows.length };
}
