// Core seat-booking logic: atomic holds, idempotent confirmation, early release,
// and TTL expiry. All inventory-mutating operations run inside a single PGLite
// transaction so concurrent requests cannot double-acquire a seat.

import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { config } from './config.js';
import { broadcast } from './sse.js';

/**
 * A serialization guard. PGLite executes one query at a time, but
 * `db.transaction` interleaves awaits; to make every seat-mutating operation
 * truly atomic with respect to each other we run them through a simple promise
 * queue. This guarantees that the "check all available then mark held" sequence
 * of one hold cannot interleave with another.
 */
let opChain = Promise.resolve();
function runExclusive(fn) {
  const result = opChain.then(() => fn());
  // Keep the chain alive even if fn rejects.
  opChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Map a raw DB row to the effective seat view. A held seat whose hold has
 * expired is reported as available.
 */
function effectiveSeat(row, now) {
  let status = row.status;
  if (status === 'held' && row.hold_expires_at) {
    const exp = new Date(row.hold_expires_at).getTime();
    if (exp <= now) {
      status = 'available';
    }
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    bookedBy: status === 'booked' ? row.booked_by : null,
    expiresAt:
      status === 'held' && row.hold_expires_at
        ? new Date(row.hold_expires_at).getTime()
        : null,
  };
}

/**
 * Release expired holds inside the given transaction. Returns the list of seat
 * ids that were released so callers can broadcast the change.
 */
async function releaseExpired(tx, now) {
  const { rows } = await tx.query(
    `UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= $1
      RETURNING id;`,
    [new Date(now).toISOString()]
  );
  return rows.map((r) => r.id);
}

/** Fetch effective seats (releasing expired holds first). */
export async function getSeats() {
  return runExclusive(async () => {
    const db = getDb();
    const now = Date.now();
    let releasedIds = [];

    await db.transaction(async (tx) => {
      releasedIds = await releaseExpired(tx, now);
    });

    const { rows } = await db.query(
      'SELECT * FROM seats ORDER BY row_label, seat_number;'
    );
    const seats = rows.map((r) => effectiveSeat(r, Date.now()));

    if (releasedIds.length > 0) {
      broadcastSeats(seats.filter((s) => releasedIds.includes(s.id)), 'released');
    }
    return seats;
  });
}

/** Compute inventory counts from effective seats. */
export function inventory(seats) {
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}

/** Broadcast a set of seat changes plus fresh inventory to all clients. */
function broadcastSeats(changedSeats, reason) {
  if (!changedSeats || changedSeats.length === 0) return;
  broadcast('seats', { seats: changedSeats, reason });
}

/**
 * Atomically place a hold on ALL requested seats. All-or-nothing: if any seat
 * is unavailable, no seat is acquired and a conflict is reported.
 *
 * @returns {{ ok: true, holdId, expiresAt, seats } | { ok: false, conflicts }}
 */
export async function createHold(seatIds, sessionId) {
  return runExclusive(async () => {
    const db = getDb();
    const now = Date.now();
    const holdId = randomUUID();
    const expiresAt = now + config.holdTtlMs;

    let outcome;
    let releasedIds = [];

    await db.transaction(async (tx) => {
      // Enforce expiry before checking availability.
      releasedIds = await releaseExpired(tx, now);

      // Load the requested seats and compute their effective status.
      const { rows } = await tx.query(
        `SELECT * FROM seats WHERE id = ANY($1::int[]);`,
        [seatIds]
      );

      const byId = new Map(rows.map((r) => [r.id, r]));
      const conflicts = [];

      for (const id of seatIds) {
        const row = byId.get(id);
        if (!row) {
          conflicts.push(id); // unknown seat id => treat as conflict
          continue;
        }
        const eff = effectiveSeat(row, now);
        if (eff.status !== 'available') {
          conflicts.push(id);
        }
      }

      if (conflicts.length > 0) {
        outcome = { ok: false, conflicts };
        return; // commit (no writes besides expiry releases)
      }

      // All available: acquire them.
      await tx.query(
        `UPDATE seats
            SET status = 'held',
                hold_id = $1,
                hold_expires_at = $2,
                booked_by = NULL
          WHERE id = ANY($3::int[]);`,
        [holdId, new Date(expiresAt).toISOString(), seatIds]
      );

      outcome = { ok: true, holdId, expiresAt, seatIds };
    });

    // Broadcast outside the transaction.
    if (releasedIds.length > 0) {
      await broadcastChangedByIds(releasedIds, 'released');
    }

    if (outcome.ok) {
      await broadcastChangedByIds(seatIds, 'held');
      const seats = await fetchSeatsByIds(seatIds);
      return {
        ok: true,
        holdId,
        expiresAt,
        ttlMs: config.holdTtlMs,
        seats,
      };
    }

    return outcome;
  });
}

/**
 * Confirm a hold: book its seats. Idempotent and transactional.
 * - Unknown / expired hold => error, books nothing.
 * - Already-booked hold => returns the same booking (no-op).
 *
 * @returns {{ ok: true, holdId, seats, alreadyBooked } | { ok: false, error }}
 */
export async function confirmHold(holdId, sessionId) {
  return runExclusive(async () => {
    const db = getDb();
    const now = Date.now();

    let outcome;
    let bookedIds = [];
    let releasedIds = [];

    await db.transaction(async (tx) => {
      releasedIds = await releaseExpired(tx, now);

      // Idempotency: if this hold already booked seats, return them.
      const { rows: alreadyRows } = await tx.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked';`,
        [holdId]
      );
      if (alreadyRows.length > 0) {
        outcome = {
          ok: true,
          holdId,
          alreadyBooked: true,
          seatIds: alreadyRows.map((r) => r.id),
        };
        return;
      }

      // Otherwise it must be an active held hold that has not expired.
      const { rows: heldRows } = await tx.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );

      if (heldRows.length === 0) {
        outcome = {
          ok: false,
          error: 'Hold not found, already released, or expired.',
        };
        return;
      }

      // Validate none have expired (releaseExpired above already cleared truly
      // expired ones, so any remaining held rows for this hold are valid).
      const stillValid = heldRows.every((r) => {
        const exp = r.hold_expires_at
          ? new Date(r.hold_expires_at).getTime()
          : 0;
        return exp > now;
      });
      if (!stillValid) {
        outcome = { ok: false, error: 'Hold has expired.' };
        return;
      }

      const ids = heldRows.map((r) => r.id);
      await tx.query(
        `UPDATE seats
            SET status = 'booked',
                booked_by = $1,
                hold_expires_at = NULL
          WHERE hold_id = $2 AND status = 'held';`,
        [sessionId ?? holdId, holdId]
      );

      bookedIds = ids;
      outcome = { ok: true, holdId, alreadyBooked: false, seatIds: ids };
    });

    if (releasedIds.length > 0) {
      await broadcastChangedByIds(releasedIds, 'released');
    }

    if (outcome.ok && bookedIds.length > 0) {
      await broadcastChangedByIds(bookedIds, 'booked');
    }

    if (outcome.ok) {
      const seats = await fetchSeatsByIds(outcome.seatIds);
      return { ok: true, holdId, alreadyBooked: outcome.alreadyBooked, seats };
    }
    return outcome;
  });
}

/**
 * Release a hold early. Returns its seats to available.
 * @returns {{ ok: true, seats } | { ok: false, error }}
 */
export async function releaseHold(holdId) {
  return runExclusive(async () => {
    const db = getDb();
    const now = Date.now();

    let releasedIds = [];
    let expiredIds = [];

    await db.transaction(async (tx) => {
      expiredIds = await releaseExpired(tx, now);

      const { rows } = await tx.query(
        `UPDATE seats
            SET status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id;`,
        [holdId]
      );
      releasedIds = rows.map((r) => r.id);
    });

    const allReleased = [...new Set([...expiredIds, ...releasedIds])];
    if (allReleased.length > 0) {
      await broadcastChangedByIds(allReleased, 'released');
    }

    if (releasedIds.length === 0) {
      return { ok: false, error: 'Hold not found or no longer active.' };
    }
    const seats = await fetchSeatsByIds(releasedIds);
    return { ok: true, seats };
  });
}

/**
 * Periodic sweep: release any holds past their TTL. Runs without the exclusive
 * queue contention concerns since it just chains onto runExclusive.
 */
export async function sweepExpired() {
  return runExclusive(async () => {
    const db = getDb();
    const now = Date.now();
    let releasedIds = [];
    await db.transaction(async (tx) => {
      releasedIds = await releaseExpired(tx, now);
    });
    if (releasedIds.length > 0) {
      await broadcastChangedByIds(releasedIds, 'released');
    }
    return releasedIds.length;
  });
}

// --- helpers that read fresh effective seats (no exclusive wrapper; callers
// already hold the queue) ---

async function fetchSeatsByIds(ids) {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT * FROM seats WHERE id = ANY($1::int[]) ORDER BY row_label, seat_number;`,
    [ids]
  );
  const now = Date.now();
  return rows.map((r) => effectiveSeat(r, now));
}

async function broadcastChangedByIds(ids, reason) {
  const seats = await fetchSeatsByIds(ids);
  broadcastSeats(seats, reason);
}
