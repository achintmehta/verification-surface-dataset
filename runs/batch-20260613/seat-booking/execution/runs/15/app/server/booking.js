import { randomUUID } from 'crypto';
import { getDb, withTxn } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcast } from './sse.js';

const now = () => Date.now();

/**
 * Public-facing seat shape. Effective status is computed: a seat that is
 * 'held' but whose hold_expires_at is in the past is reported as available.
 */
function effectiveSeat(row, ts) {
  let status = row.status;
  if (
    status === 'held' &&
    row.hold_expires_at != null &&
    Number(row.hold_expires_at) <= ts
  ) {
    status = 'available';
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    holdExpiresAt: status === 'held' ? Number(row.hold_expires_at) : null,
    bookedBy: row.status === 'booked' ? row.booked_by : null
  };
}

// ---------------------------------------------------------------------------
// Expiry: release any held seat whose hold has elapsed. Runs inside a txn (or
// reuses an existing txn's db handle). Returns the list of released seat ids.
// ---------------------------------------------------------------------------
async function releaseExpiredWithin(db, ts) {
  // Find expired active holds.
  const { rows: expired } = await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= $1
      RETURNING id`,
    [ts]
  );
  if (expired.length > 0) {
    await db.query(
      `UPDATE holds SET status = 'expired'
        WHERE status = 'active' AND expires_at <= $1`,
      [ts]
    );
  }
  return expired.map((r) => r.id);
}

/**
 * Sweep expired holds in its own transaction and broadcast releases.
 */
export async function sweepExpired() {
  const ts = now();
  const released = await withTxn((db) => releaseExpiredWithin(db, ts));
  if (released.length > 0) {
    broadcast(
      released.map((id) => ({ id, status: 'available' })),
      'expired'
    );
  }
  return released;
}

/**
 * Read the full seat map with effective statuses. Lazily expires stale holds
 * first and broadcasts any resulting releases.
 */
export async function getSeats() {
  await sweepExpired();
  const db = await getDb();
  const ts = now();
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      ORDER BY row_label, seat_number`
  );
  return rows.map((r) => effectiveSeat(r, ts));
}

/**
 * Atomically acquire ALL requested seats. All-or-nothing: if any requested
 * seat is not available, none are taken and a conflict is returned.
 *
 * @returns {{ok:true, hold}} | {{ok:false, conflicts:string[]}}
 */
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { ok: false, error: 'seatIds must be a non-empty array' };
  }
  if (!sessionId) {
    return { ok: false, error: 'sessionId is required' };
  }
  // De-duplicate requested ids.
  const ids = [...new Set(seatIds)];

  const result = await withTxn(async (db) => {
    const ts = now();
    // Expire stale holds first so freed seats become acquirable.
    const released = await releaseExpiredWithin(db, ts);

    // Lock & inspect the requested rows.
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows: seatRows } = await db.query(
      `SELECT id, status, hold_expires_at
         FROM seats
        WHERE id IN (${placeholders})`,
      ids
    );

    // Unknown seat ids are conflicts too.
    const found = new Map(seatRows.map((r) => [r.id, r]));
    const conflicts = [];
    for (const id of ids) {
      const r = found.get(id);
      if (!r) {
        conflicts.push(id);
        continue;
      }
      const isExpiredHold =
        r.status === 'held' &&
        r.hold_expires_at != null &&
        Number(r.hold_expires_at) <= ts;
      const available = r.status === 'available' || isExpiredHold;
      if (!available) conflicts.push(id);
    }

    if (conflicts.length > 0) {
      // All-or-nothing: take nothing.
      return { ok: false, conflicts, released };
    }

    const holdId = randomUUID();
    const expiresAt = ts + HOLD_TTL_MS;

    await db.query(
      `INSERT INTO holds (id, session_id, created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [holdId, sessionId, ts, expiresAt]
    );

    // Conditional update guarding against any race: only flip seats that are
    // still available (or carry an already-expired hold).
    // params: $1 = holdId, $2 = expiresAt, $3 = ts, $4.. = ids
    const updPlaceholders = ids.map((_, i) => `$${i + 4}`).join(',');
    const { rows: updated } = await db.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2
        WHERE id IN (${updPlaceholders})
          AND (status = 'available'
               OR (status = 'held' AND hold_expires_at <= $3))
        RETURNING id`,
      [holdId, expiresAt, ts, ...ids]
    );

    if (updated.length !== ids.length) {
      // Lost a race on some seat -> abort entirely (rollback).
      const taken = new Set(updated.map((r) => r.id));
      const lost = ids.filter((id) => !taken.has(id));
      throw new HoldConflict(lost);
    }

    return {
      ok: true,
      released,
      hold: {
        id: holdId,
        sessionId,
        seatIds: ids,
        expiresAt,
        createdAt: ts
      }
    };
  }).catch((err) => {
    if (err instanceof HoldConflict) {
      return { ok: false, conflicts: err.conflicts, released: [] };
    }
    throw err;
  });

  // Broadcast outside the txn.
  if (result.released && result.released.length > 0) {
    broadcast(result.released.map((id) => ({ id, status: 'available' })), 'expired');
  }
  if (result.ok) {
    broadcast(
      result.hold.seatIds.map((id) => ({
        id,
        status: 'held',
        holdExpiresAt: result.hold.expiresAt
      })),
      'held'
    );
  }
  return result;
}

class HoldConflict extends Error {
  constructor(conflicts) {
    super('hold conflict');
    this.conflicts = conflicts;
  }
}

/**
 * Confirm a hold: book its seats. Idempotent — confirming a hold that was
 * already confirmed returns the same booking and books nothing additional.
 * Expired or unknown holds fail and book nothing.
 */
export async function confirmHold(holdId, sessionId) {
  const result = await withTxn(async (db) => {
    const ts = now();
    await releaseExpiredWithin(db, ts);

    const { rows: holdRows } = await db.query(
      `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1`,
      [holdId]
    );
    const hold = holdRows[0];
    if (!hold) {
      return { ok: false, status: 404, error: 'unknown hold' };
    }

    // Idempotency: already confirmed -> return existing booked seats.
    if (hold.status === 'confirmed') {
      const { rows: booked } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      return {
        ok: true,
        alreadyConfirmed: true,
        booking: { holdId, seatIds: booked.map((r) => r.id) },
        broadcastSeats: []
      };
    }

    if (hold.status !== 'active' || Number(hold.expires_at) <= ts) {
      return { ok: false, status: 409, error: 'hold expired or invalid' };
    }

    if (sessionId && hold.session_id !== sessionId) {
      return { ok: false, status: 403, error: 'hold belongs to another session' };
    }

    // Re-validate ownership: every seat must still be held by THIS hold.
    const { rows: ownedSeats } = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1`,
      [holdId]
    );
    const valid = ownedSeats.filter(
      (s) => s.status === 'held' && Number(s.hold_expires_at) > ts
    );
    if (valid.length === 0) {
      return { ok: false, status: 409, error: 'hold no longer owns its seats' };
    }

    const seatIds = valid.map((s) => s.id);
    // params: $1 = booked_by, $2 = holdId, $3 = ts, $4.. = seatIds
    const placeholders = seatIds.map((_, i) => `$${i + 4}`).join(',');
    const { rows: bookedRows } = await db.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
        WHERE hold_id = $2
          AND id IN (${placeholders})
          AND status = 'held'
          AND hold_expires_at > $3
        RETURNING id`,
      [hold.session_id, holdId, ts, ...seatIds]
    );

    await db.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

    return {
      ok: true,
      booking: { holdId, seatIds: bookedRows.map((r) => r.id) },
      broadcastSeats: bookedRows.map((r) => ({ id: r.id, status: 'booked' }))
    };
  });

  if (result.ok && result.broadcastSeats && result.broadcastSeats.length > 0) {
    broadcast(result.broadcastSeats, 'booked');
  }
  return result;
}

/**
 * Release a hold early. Returns held seats to available.
 */
export async function releaseHold(holdId, sessionId) {
  const result = await withTxn(async (db) => {
    const ts = now();
    const { rows: holdRows } = await db.query(
      `SELECT id, session_id, status FROM holds WHERE id = $1`,
      [holdId]
    );
    const hold = holdRows[0];
    if (!hold) {
      return { ok: false, status: 404, error: 'unknown hold' };
    }
    if (hold.status === 'confirmed') {
      return { ok: false, status: 409, error: 'hold already confirmed' };
    }
    if (sessionId && hold.session_id !== sessionId) {
      return { ok: false, status: 403, error: 'hold belongs to another session' };
    }

    const { rows: released } = await db.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id`,
      [holdId]
    );
    await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    return {
      ok: true,
      released: released.map((r) => r.id)
    };
  });

  if (result.ok && result.released.length > 0) {
    broadcast(result.released.map((id) => ({ id, status: 'available' })), 'released');
  }
  return result;
}

/**
 * Inventory summary used for sanity checks / debugging.
 */
export async function getInventory() {
  await sweepExpired();
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS c FROM seats GROUP BY status`
  );
  const counts = { available: 0, held: 0, booked: 0 };
  for (const r of rows) counts[r.status] = r.c;
  counts.total = counts.available + counts.held + counts.booked;
  return counts;
}
