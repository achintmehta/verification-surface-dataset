import { randomUUID } from 'node:crypto';
import { getDb, withLock } from './db.js';
import { HOLD_TTL_MS } from './config.js';

// Broadcaster injected by the SSE layer. Defaults to a no-op so the module is
// usable/testable without SSE wired up.
let broadcast = () => {};
export function setBroadcaster(fn) {
  broadcast = fn;
}

/**
 * Release any holds whose expires_at is in the past. Runs inside the caller's
 * transaction (tx). Returns the list of seat ids that transitioned back to
 * available so the caller can broadcast them.
 *
 * Only seats that are currently 'held' (not booked) are released.
 */
async function expireHoldsTx(tx) {
  // Mark the expired hold rows.
  await tx.query(
    `UPDATE holds SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now();`
  );

  // Free seats attached to an expired/non-active hold.
  const res = await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at <= now()
      RETURNING id;`
  );
  return res.rows.map((r) => r.id);
}

/** Map a raw seat row into the API shape with an effective status. */
function toSeatDTO(row) {
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status: row.status,
    holdId: row.hold_id || null,
    holdExpiresAt: row.hold_expires_at
      ? new Date(row.hold_expires_at).toISOString()
      : null,
    bookedBy: row.booked_by || null,
  };
}

/**
 * Read all seats. Expiry is enforced first so a held-but-expired seat is
 * reported (and persisted) as available. Broadcasts any releases caused by the
 * lazy expiry sweep.
 */
export async function listSeats() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    const rows = await db.transaction(async (tx) => {
      released = await expireHoldsTx(tx);
      const res = await tx.query(
        `SELECT * FROM seats ORDER BY row_label, seat_number;`
      );
      return res.rows;
    });
    if (released.length) {
      broadcast({ type: 'released', seatIds: released });
    }
    return rows.map(toSeatDTO);
  });
}

/** Inventory snapshot used for sanity / acceptance checks. */
export async function inventory() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    const counts = await db.transaction(async (tx) => {
      released = await expireHoldsTx(tx);
      const res = await tx.query(
        `SELECT status, COUNT(*)::int AS n FROM seats GROUP BY status;`
      );
      const out = { available: 0, held: 0, booked: 0 };
      for (const r of res.rows) out[r.status] = r.n;
      out.total = out.available + out.held + out.booked;
      return out;
    });
    if (released.length) broadcast({ type: 'released', seatIds: released });
    return counts;
  });
}

/**
 * Atomically acquire ALL of `seatIds` for `sessionId`. All-or-nothing.
 *
 * Returns { ok: true, hold } on success.
 * Returns { ok: false, conflicts: [...] } if any requested seat is unavailable.
 */
export async function createHold(seatIds, sessionId) {
  // Normalize + de-duplicate while preserving order.
  const ids = [...new Set(seatIds)];

  return withLock(async () => {
    const db = getDb();
    let released = [];
    let result;

    await db.transaction(async (tx) => {
      // 1. Enforce expiry first so freshly-expired seats are acquirable.
      released = await expireHoldsTx(tx);

      // 2. Lock & inspect the requested seats.
      const res = await tx.query(
        `SELECT id, status, hold_expires_at
           FROM seats
          WHERE id = ANY($1::text[])
          FOR UPDATE;`,
        [ids]
      );

      const found = new Map(res.rows.map((r) => [r.id, r]));

      // Seats that don't exist are treated as conflicts (cannot be acquired).
      const conflicts = [];
      for (const id of ids) {
        const row = found.get(id);
        if (!row || row.status !== 'available') {
          conflicts.push(id);
        }
      }

      if (conflicts.length > 0) {
        // All-or-nothing: acquire none. Throwing rolls back the transaction.
        result = { ok: false, conflicts };
        return;
      }

      // 3. Create the hold and mark every seat held in one shot.
      const holdId = randomUUID();
      const ttlSeconds = HOLD_TTL_MS / 1000;

      const holdRes = await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
         RETURNING id, session_id, created_at, expires_at, status;`,
        [holdId, sessionId, String(ttlSeconds)]
      );
      const hold = holdRes.rows[0];

      await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id = ANY($3::text[]);`,
        [holdId, hold.expires_at, ids]
      );

      result = {
        ok: true,
        hold: {
          id: hold.id,
          sessionId: hold.session_id,
          seatIds: ids,
          createdAt: new Date(hold.created_at).toISOString(),
          expiresAt: new Date(hold.expires_at).toISOString(),
          status: hold.status,
        },
      };
    });

    // Broadcast outside the transaction.
    if (released.length) broadcast({ type: 'released', seatIds: released });
    if (result.ok) {
      broadcast({
        type: 'held',
        seatIds: result.hold.seatIds,
        holdId: result.hold.id,
        expiresAt: result.hold.expiresAt,
      });
    }
    return result;
  });
}

/**
 * Confirm a hold: book its seats. Transactional and idempotent.
 *
 * Returns { ok: true, booking, alreadyConfirmed } on success.
 * Returns { ok: false, error } if the hold is unknown/expired/released.
 */
export async function confirmHold(holdId, sessionId) {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    let result;
    let bookedSeatIds = [];

    await db.transaction(async (tx) => {
      // Enforce expiry before validating the hold.
      released = await expireHoldsTx(tx);

      // Lock the hold row.
      const holdRes = await tx.query(
        `SELECT id, session_id, expires_at, status
           FROM holds WHERE id = $1 FOR UPDATE;`,
        [holdId]
      );

      if (holdRes.rows.length === 0) {
        result = { ok: false, error: 'unknown_hold', message: 'Hold not found.' };
        return;
      }

      const hold = holdRes.rows[0];

      // Optional ownership check: if a sessionId is provided it must match.
      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, error: 'forbidden', message: 'Hold belongs to another session.' };
        return;
      }

      // Idempotency: a hold already confirmed returns the same booking.
      if (hold.status === 'confirmed') {
        const seatRes = await tx.query(
          `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY id;`,
          [holdId]
        );
        result = {
          ok: true,
          alreadyConfirmed: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: seatRes.rows.map((r) => r.id),
          },
        };
        return;
      }

      if (hold.status !== 'active') {
        // released or expired
        result = {
          ok: false,
          error: 'hold_inactive',
          message: `Hold is ${hold.status} and can no longer be confirmed.`,
        };
        return;
      }

      // Active but expired by time (defensive; expireHoldsTx should have caught it).
      const expRes = await tx.query(
        `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1;`,
        [holdId]
      );
      if (expRes.rows[0].expired) {
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1;`, [holdId]);
        const freed = await tx.query(
          `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL
            WHERE hold_id = $1 AND status = 'held' RETURNING id;`,
          [holdId]
        );
        released = released.concat(freed.rows.map((r) => r.id));
        result = { ok: false, error: 'expired', message: 'Hold has expired.' };
        return;
      }

      // Book all seats currently held under this hold.
      const bookRes = await tx.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id;`,
        [holdId, hold.session_id]
      );
      bookedSeatIds = bookRes.rows.map((r) => r.id);

      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1;`, [holdId]);

      result = {
        ok: true,
        alreadyConfirmed: false,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: bookedSeatIds,
        },
      };
    });

    if (released.length) broadcast({ type: 'released', seatIds: released });
    if (result.ok && !result.alreadyConfirmed && bookedSeatIds.length) {
      broadcast({ type: 'booked', seatIds: bookedSeatIds });
    }
    return result;
  });
}

/**
 * Release a hold early, returning its held seats to available. Booked seats are
 * never released. Idempotent: releasing an already-gone hold is a no-op success.
 */
export async function releaseHold(holdId, sessionId) {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    let result;

    await db.transaction(async (tx) => {
      const expiredFreed = await expireHoldsTx(tx);

      const holdRes = await tx.query(
        `SELECT id, session_id, status FROM holds WHERE id = $1 FOR UPDATE;`,
        [holdId]
      );

      if (holdRes.rows.length === 0) {
        released = expiredFreed;
        result = { ok: true, seatIds: [], note: 'unknown_hold_noop' };
        return;
      }

      const hold = holdRes.rows[0];
      if (sessionId && hold.session_id !== sessionId) {
        released = expiredFreed;
        result = { ok: false, error: 'forbidden', message: 'Hold belongs to another session.' };
        return;
      }

      if (hold.status === 'confirmed') {
        released = expiredFreed;
        result = { ok: false, error: 'already_confirmed', message: 'Cannot release a confirmed hold.' };
        return;
      }

      const freed = await tx.query(
        `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL
          WHERE hold_id = $1 AND status = 'held' RETURNING id;`,
        [holdId]
      );
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1;`, [holdId]);

      const freedIds = freed.rows.map((r) => r.id);
      released = expiredFreed.concat(freedIds);
      result = { ok: true, seatIds: freedIds };
    });

    if (released.length) broadcast({ type: 'released', seatIds: released });
    return result;
  });
}

/** Background sweep: release expired holds and broadcast. */
export async function sweepExpired() {
  return withLock(async () => {
    const db = getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireHoldsTx(tx);
    });
    if (released.length) broadcast({ type: 'released', seatIds: released });
    return released;
  });
}
