import { randomUUID } from 'crypto';
import { getDb, HOLD_TTL_MS } from './db.js';

// Serialize write operations within this single-process server to guarantee
// the atomic check-and-set semantics for seat acquisition. PGlite runs an
// embedded single-connection Postgres; this mutex queue makes each
// hold/confirm/release/sweep run to completion before the next begins, so two
// concurrent hold requests for the same seat can never both succeed.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of success/failure of fn.
  chain = run.then(() => {}, () => {});
  return run;
}

let broadcaster = () => {};
export function setBroadcaster(fn) {
  broadcaster = fn;
}

function publicSeat(s) {
  return {
    id: s.id,
    rowLabel: s.row_label,
    seatNumber: s.seat_number,
    status: s.status,
    holdId: s.hold_id || null,
    holdExpiresAt: s.hold_expires_at ? new Date(s.hold_expires_at).toISOString() : null,
    bookedBy: s.booked_by || null,
  };
}

/**
 * Release any held seats whose hold has expired. Runs inside the provided tx.
 * Returns the list of seat ids that were released so the caller can broadcast.
 */
async function expireStaleHolds(tx) {
  // Mark holds whose time has passed as expired.
  await tx.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  const { rows: released } = await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= now()
      RETURNING *`
  );
  return released;
}

/** Read all seats, applying lazy expiry first. Returns public seats + changes. */
export async function readSeats() {
  return withLock(async () => {
    const db = await getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    const db2 = await getDb();
    const { rows } = await db2.query('SELECT * FROM seats ORDER BY row_label, seat_number');
    const seats = rows.map(publicSeat);
    if (released.length) {
      broadcaster({ type: 'released', seats: released.map(publicSeat) });
    }
    return seats;
  });
}

/** Compute inventory counts (after expiry). */
export async function inventory() {
  const seats = await readSeats();
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}

/**
 * Atomically place a hold on ALL requested seats, all-or-nothing.
 * Returns { ok, hold, seats } or { ok:false, conflicts }.
 */
export async function createHold(seatIds, sessionId) {
  return withLock(async () => {
    const db = await getDb();
    const holdId = randomUUID();
    const expiresAtMs = Date.now() + HOLD_TTL_MS;

    let result;
    let released = [];

    await db.transaction(async (tx) => {
      // 1. Lazy-expire stale holds first so freshly freed seats are acquirable.
      released = await expireStaleHolds(tx);

      // 2. Lock & inspect the requested seats.
      const { rows: targetSeats } = await tx.query(
        `SELECT * FROM seats WHERE id = ANY($1::text[]) FOR UPDATE`,
        [seatIds]
      );

      const found = new Set(targetSeats.map((s) => s.id));
      const missing = seatIds.filter((id) => !found.has(id));
      const conflicts = [
        ...missing,
        ...targetSeats.filter((s) => s.status !== 'available').map((s) => s.id),
      ];

      if (conflicts.length > 0) {
        result = { ok: false, conflicts };
        return; // transaction commits, but no seat state changed
      }

      // 3. All available — acquire them atomically.
      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), 'active')`,
        [holdId, sessionId, expiresAtMs]
      );

      const { rows: updated } = await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1,
                hold_expires_at = to_timestamp($2 / 1000.0)
          WHERE id = ANY($3::text[])
          RETURNING *`,
        [holdId, expiresAtMs, seatIds]
      );

      result = {
        ok: true,
        hold: {
          id: holdId,
          sessionId,
          status: 'active',
          expiresAt: new Date(expiresAtMs).toISOString(),
          seatIds: updated.map((s) => s.id),
        },
        seats: updated.map(publicSeat),
      };
    });

    if (released.length) {
      broadcaster({ type: 'released', seats: released.map(publicSeat) });
    }
    if (result.ok) {
      broadcaster({ type: 'held', seats: result.seats });
    }
    return result;
  });
}

/**
 * Confirm a hold: book its seats. Idempotent — a second confirm of an
 * already-confirmed hold returns the same booking and books nothing more.
 * Expired/unknown holds fail and book nothing.
 */
export async function confirmHold(holdId, sessionId) {
  return withLock(async () => {
    const db = await getDb();
    let result;
    let released = [];
    let booked = [];

    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        result = { ok: false, error: 'unknown_hold' };
        return;
      }
      const hold = holdRows[0];

      // Optional ownership check.
      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, error: 'not_owner' };
        return;
      }

      // Idempotency: already confirmed -> return existing booking.
      if (hold.status === 'confirmed') {
        const { rows: seats } = await tx.query(
          `SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY row_label, seat_number`,
          [holdId]
        );
        result = {
          ok: true,
          idempotent: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: seats.map((s) => s.id),
          },
          seats: seats.map(publicSeat),
        };
        return;
      }

      if (hold.status !== 'active') {
        result = { ok: false, error: 'hold_' + hold.status };
        return;
      }

      // Re-validate expiry inside the transaction.
      const { rows: expiredCheck } = await tx.query(
        `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1`,
        [holdId]
      );
      if (expiredCheck[0].expired) {
        // Release its seats now and fail.
        const { rows: rel } = await tx.query(
          `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL
             WHERE hold_id=$1 AND status='held' RETURNING *`,
          [holdId]
        );
        await tx.query(`UPDATE holds SET status='expired' WHERE id=$1`, [holdId]);
        released = released.concat(rel);
        result = { ok: false, error: 'hold_expired' };
        return;
      }

      // Verify the hold still owns its held seats and book them.
      const { rows: bookedRows } = await tx.query(
        `UPDATE seats
            SET status='booked', booked_by=$2, hold_expires_at=NULL
          WHERE hold_id=$1 AND status='held'
          RETURNING *`,
        [holdId, hold.session_id]
      );

      await tx.query(`UPDATE holds SET status='confirmed' WHERE id=$1`, [holdId]);

      booked = bookedRows;
      result = {
        ok: true,
        idempotent: false,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: bookedRows.map((s) => s.id),
        },
        seats: bookedRows.map(publicSeat),
      };
    });

    if (released.length) {
      broadcaster({ type: 'released', seats: released.map(publicSeat) });
    }
    if (booked.length) {
      broadcaster({ type: 'booked', seats: booked.map(publicSeat) });
    }
    return result;
  });
}

/** Release a hold early; its seats return to available. */
export async function releaseHold(holdId, sessionId) {
  return withLock(async () => {
    const db = await getDb();
    let result;
    let released = [];
    let stale = [];

    await db.transaction(async (tx) => {
      stale = await expireStaleHolds(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id=$1 FOR UPDATE`,
        [holdId]
      );
      if (holdRows.length === 0) {
        result = { ok: false, error: 'unknown_hold' };
        return;
      }
      const hold = holdRows[0];
      if (sessionId && hold.session_id !== sessionId) {
        result = { ok: false, error: 'not_owner' };
        return;
      }
      if (hold.status === 'confirmed') {
        result = { ok: false, error: 'already_confirmed' };
        return;
      }
      if (hold.status !== 'active') {
        // already released/expired — idempotent success
        result = { ok: true, seatIds: [] };
        return;
      }

      const { rows: rel } = await tx.query(
        `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL
           WHERE hold_id=$1 AND status='held' RETURNING *`,
        [holdId]
      );
      await tx.query(`UPDATE holds SET status='released' WHERE id=$1`, [holdId]);
      released = rel;
      result = { ok: true, seatIds: rel.map((s) => s.id) };
    });

    const all = stale.concat(released);
    if (all.length) {
      broadcaster({ type: 'released', seats: all.map(publicSeat) });
    }
    return result;
  });
}

/** Periodic sweep to release stale holds proactively. */
export async function sweep() {
  return withLock(async () => {
    const db = await getDb();
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length) {
      broadcaster({ type: 'released', seats: released.map(publicSeat) });
    }
    return released.map((s) => s.id);
  });
}
