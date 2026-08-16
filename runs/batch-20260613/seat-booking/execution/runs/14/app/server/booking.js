import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { HOLD_TTL_MS } from './config.js';
import { broadcastSeats } from './sse.js';

/**
 * The booking engine. All seat-mutating operations run inside a single
 * PGlite transaction. PGlite executes queries serially (single connection),
 * which combined with the all-or-nothing conditional updates below guarantees
 * that two concurrent requests can never acquire or book the same seat.
 *
 * Expiry is enforced lazily: before every read or mutation we release any
 * holds whose expires_at has passed, returning their seats to 'available'.
 */

// Serialize transactions in-process. PGlite is single-connection; running two
// db.transaction() calls concurrently can interleave statements. A simple
// promise queue makes each logical operation atomic end-to-end.
let txChain = Promise.resolve();
function withLock(fn) {
  const run = txChain.then(fn, fn);
  // Keep the chain alive even if fn rejects.
  txChain = run.then(() => {}, () => {});
  return run;
}

const SELECT_SEAT_COLUMNS = `
  id, row_label, seat_number, status, hold_id,
  hold_expires_at, booked_by
`;

function mapSeat(r) {
  return {
    id: r.id,
    rowLabel: r.row_label,
    seatNumber: r.seat_number,
    status: r.status,
    holdId: r.hold_id,
    holdExpiresAt: r.hold_expires_at ? new Date(r.hold_expires_at).toISOString() : null,
    bookedBy: r.booked_by,
  };
}

/**
 * Release expired holds inside an existing transaction `tx`.
 * Returns the list of seat rows that were released (for broadcasting).
 */
async function releaseExpiredHoldsTx(tx) {
  // Mark expired holds.
  await tx.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  // Free seats whose hold has expired (regardless of holds row state, we key
  // off the seat's own hold_expires_at to be fully self-consistent).
  const { rows } = await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= now()
      RETURNING ${SELECT_SEAT_COLUMNS}`
  );
  return rows;
}

/**
 * Return all seats with their effective status (expired holds reported as
 * available). Also performs a lazy sweep and broadcasts any releases.
 */
export async function getSeats() {
  const db = getDb();
  return withLock(async () => {
    let released = [];
    const seats = await db.transaction(async (tx) => {
      released = await releaseExpiredHoldsTx(tx);
      const { rows } = await tx.query(
        `SELECT ${SELECT_SEAT_COLUMNS} FROM seats ORDER BY id`
      );
      return rows.map(mapSeat);
    });
    if (released.length) broadcastSeats(released.map(mapSeat));
    return seats;
  });
}

/**
 * Atomically place a hold on ALL requested seats. All-or-nothing.
 *
 * @returns {{ ok: true, hold } | { ok: false, code, conflicts }}
 */
export async function createHold(seatIds, sessionId) {
  const db = getDb();

  // Validate / normalize input.
  const ids = Array.from(new Set((seatIds || []).map(Number))).filter(
    (n) => Number.isInteger(n) && n > 0
  );
  if (ids.length === 0) {
    return { ok: false, code: 'BAD_REQUEST', message: 'No valid seatIds provided.' };
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'sessionId is required.' };
  }

  return withLock(async () => {
    let releasedRows = [];
    let result;

    await db.transaction(async (tx) => {
      // 1. Enforce expiry first so just-expired seats are acquirable.
      releasedRows = await releaseExpiredHoldsTx(tx);

      // 2. Check that every requested seat exists and is available.
      const { rows: current } = await tx.query(
        `SELECT ${SELECT_SEAT_COLUMNS} FROM seats WHERE id = ANY($1::int[])`,
        [ids]
      );
      const found = new Map(current.map((r) => [r.id, r]));

      const missing = ids.filter((id) => !found.has(id));
      const conflicts = ids.filter((id) => {
        const s = found.get(id);
        return s && s.status !== 'available';
      });

      if (missing.length || conflicts.length) {
        result = {
          ok: false,
          code: 'CONFLICT',
          conflicts,
          missing,
        };
        return; // transaction commits, but no seat changes were made
      }

      // 3. Acquire. Conditional update on status='available' makes this an
      //    atomic check-and-set; affected row count must equal ids.length.
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
             VALUES ($1, $2, $3::int[], $4, 'active')`,
        [holdId, sessionId, ids, expiresAt.toISOString()]
      );

      const { rows: updated } = await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id = ANY($3::int[]) AND status = 'available'
          RETURNING ${SELECT_SEAT_COLUMNS}`,
        [holdId, expiresAt.toISOString(), ids]
      );

      // Defensive: if we somehow didn't grab all of them, roll back.
      if (updated.length !== ids.length) {
        throw new Error('SEAT_RACE'); // aborts transaction -> nothing committed
      }

      result = {
        ok: true,
        hold: {
          id: holdId,
          sessionId,
          expiresAt: expiresAt.toISOString(),
          ttlMs: HOLD_TTL_MS,
          seatIds: ids,
        },
        heldSeats: updated.map(mapSeat),
      };
    }).catch((err) => {
      if (err && err.message === 'SEAT_RACE') {
        result = { ok: false, code: 'CONFLICT', conflicts: ids, missing: [] };
      } else {
        throw err;
      }
    });

    // Broadcast releases (from expiry) and any newly held seats.
    const events = [];
    if (releasedRows.length) events.push(...releasedRows.map(mapSeat));
    if (result.ok) events.push(...result.heldSeats);
    if (events.length) broadcastSeats(events);

    return result;
  });
}

/**
 * Confirm a hold: book its seats. Transactional and idempotent.
 *
 * @returns {{ ok: true, booking } | { ok: false, code, message }}
 */
export async function confirmHold(holdId) {
  const db = getDb();
  if (!holdId || typeof holdId !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'holdId is required.' };
  }

  return withLock(async () => {
    let releasedRows = [];
    let result;

    await db.transaction(async (tx) => {
      releasedRows = await releaseExpiredHoldsTx(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1`,
        [holdId]
      );
      const hold = holdRows[0];

      if (!hold) {
        result = { ok: false, code: 'NOT_FOUND', message: 'Unknown hold.' };
        return;
      }

      const holdSeatIds = (hold.seat_ids || []).map(Number);

      // Idempotency: already confirmed -> return existing booking, book nothing.
      if (hold.status === 'confirmed') {
        result = {
          ok: true,
          idempotent: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: holdSeatIds,
          },
          bookedSeats: [],
        };
        return;
      }

      if (hold.status === 'expired') {
        result = { ok: false, code: 'HOLD_EXPIRED', message: 'Hold has expired.' };
        return;
      }

      if (hold.status !== 'active') {
        // 'released' (or any other non-active state).
        result = {
          ok: false,
          code: 'HOLD_INACTIVE',
          message: `Hold is ${hold.status}.`,
        };
        return;
      }

      // Expired (defensive; releaseExpiredHoldsTx already marks them).
      const { rows: expCheck } = await tx.query(
        `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1`,
        [holdId]
      );
      if (expCheck[0] && expCheck[0].expired) {
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        result = { ok: false, code: 'HOLD_EXPIRED', message: 'Hold has expired.' };
        return;
      }

      // Book exactly the seats this hold still owns and that are currently held.
      const { rows: booked } = await tx.query(
        `UPDATE seats
            SET status = 'booked',
                booked_by = $1,
                hold_id = NULL,
                hold_expires_at = NULL
          WHERE hold_id = $2 AND status = 'held'
          RETURNING ${SELECT_SEAT_COLUMNS}`,
        [hold.session_id, holdId]
      );

      if (booked.length === 0) {
        // The hold owned no held seats anymore (e.g. all released/expired).
        await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        result = {
          ok: false,
          code: 'HOLD_EXPIRED',
          message: 'Hold no longer owns any seats.',
        };
        return;
      }

      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      result = {
        ok: true,
        idempotent: false,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: booked.map((r) => r.id),
        },
        bookedSeats: booked.map(mapSeat),
      };
    });

    const events = [];
    if (releasedRows.length) events.push(...releasedRows.map(mapSeat));
    if (result.ok && result.bookedSeats && result.bookedSeats.length) {
      events.push(...result.bookedSeats);
    }
    if (events.length) broadcastSeats(events);

    return result;
  });
}

/**
 * Release a hold early, returning its seats to available.
 */
export async function releaseHold(holdId) {
  const db = getDb();
  if (!holdId || typeof holdId !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'holdId is required.' };
  }

  return withLock(async () => {
    let releasedRows = [];
    let freed = [];
    let result;

    await db.transaction(async (tx) => {
      releasedRows = await releaseExpiredHoldsTx(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT id, status FROM holds WHERE id = $1`,
        [holdId]
      );
      const hold = holdRows[0];
      if (!hold) {
        result = { ok: false, code: 'NOT_FOUND', message: 'Unknown hold.' };
        return;
      }
      if (hold.status === 'confirmed') {
        result = { ok: false, code: 'ALREADY_CONFIRMED', message: 'Hold already confirmed.' };
        return;
      }

      const { rows } = await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING ${SELECT_SEAT_COLUMNS}`,
        [holdId]
      );
      freed = rows;
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      result = { ok: true, releasedSeats: rows.map(mapSeat) };
    });

    const events = [];
    if (releasedRows.length) events.push(...releasedRows.map(mapSeat));
    if (freed.length) events.push(...freed.map(mapSeat));
    if (events.length) broadcastSeats(events);

    return result;
  });
}

/**
 * Background sweep: release stale holds and broadcast.
 */
export async function sweepExpiredHolds() {
  const db = getDb();
  return withLock(async () => {
    let released = [];
    await db.transaction(async (tx) => {
      released = await releaseExpiredHoldsTx(tx);
    });
    if (released.length) broadcastSeats(released.map(mapSeat));
    return released.map(mapSeat);
  });
}

/**
 * Inventory counts for diagnostics / acceptance checks.
 */
export async function getInventory() {
  const seats = await getSeats();
  const inv = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) inv[s.status]++;
  return inv;
}
