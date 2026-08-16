import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { config } from './config.js';
import { broadcastSeatUpdate } from './sse.js';

// ---------------------------------------------------------------------------
// Serialization
//
// PGLite is an embedded, single-connection database. To guarantee that two
// concurrent hold/confirm/release operations cannot interleave their
// read-modify-write cycles, we funnel every mutating operation through a single
// in-process promise chain (a mutex). Combined with explicit SQL transactions
// this makes seat acquisition strictly atomic and all-or-nothing.
// ---------------------------------------------------------------------------
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  // Keep the chain alive even if fn rejects, but don't swallow the result.
  mutex = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Map a raw DB seat row to its effective public representation. A seat whose
// hold has expired is reported as available even before the sweep rewrites it.
function toEffectiveSeat(row, nowMs) {
  let status = row.status;
  let holdId = row.hold_id;
  let holdExpiresAt = row.hold_expires_at;
  let bookedBy = row.booked_by;

  if (status === 'held') {
    const exp = holdExpiresAt ? new Date(holdExpiresAt).getTime() : 0;
    if (exp <= nowMs) {
      status = 'available';
      holdId = null;
      holdExpiresAt = null;
    }
  }

  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: holdId || null,
    holdExpiresAt: holdExpiresAt ? new Date(holdExpiresAt).toISOString() : null,
    bookedBy: bookedBy || null,
  };
}

// ---------------------------------------------------------------------------
// Expiry sweep: release every hold whose expires_at has passed. Returns the
// list of effective seat objects that changed so callers can broadcast them.
// Must be called while holding the lock (or from within a locked section).
// ---------------------------------------------------------------------------
async function releaseExpiredInternal(pg) {
  const nowIso = new Date().toISOString();

  // Find seats currently held by an expired hold.
  const expired = await pg.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      WHERE status = 'held' AND hold_expires_at <= $1;`,
    [nowIso]
  );

  if (expired.rows.length === 0) return [];

  await pg.query('BEGIN;');
  try {
    await pg.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held' AND hold_expires_at <= $1;`,
      [nowIso]
    );
    await pg.query(
      `UPDATE holds SET state = 'released'
        WHERE state = 'active' AND expires_at <= $1;`,
      [nowIso]
    );
    await pg.query('COMMIT;');
  } catch (e) {
    await pg.query('ROLLBACK;');
    throw e;
  }

  const nowMs = Date.now();
  // Return the freed seats in their new (available) state.
  return expired.rows.map((r) =>
    toEffectiveSeat(
      { ...r, status: 'available', hold_id: null, hold_expires_at: null },
      nowMs
    )
  );
}

// Public: run the sweep, broadcasting any releases. Used by the periodic timer.
export async function sweepExpired() {
  return withLock(async () => {
    const pg = await getDb();
    const released = await releaseExpiredInternal(pg);
    if (released.length > 0) broadcastSeatUpdate(released);
    return released;
  });
}

// ---------------------------------------------------------------------------
// Read all seats with effective status. Expiry is enforced on read: stale
// holds are released (and broadcast) before returning the snapshot.
// ---------------------------------------------------------------------------
export async function getSeats() {
  return withLock(async () => {
    const pg = await getDb();
    const released = await releaseExpiredInternal(pg);
    if (released.length > 0) broadcastSeatUpdate(released);

    const res = await pg.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
        ORDER BY row_label, seat_number;`
    );
    const nowMs = Date.now();
    return res.rows.map((r) => toEffectiveSeat(r, nowMs));
  });
}

// ---------------------------------------------------------------------------
// Create a hold over the requested seats. All-or-nothing: every requested seat
// must currently be available (after expiry enforcement) or the whole request
// fails with the list of conflicting seat ids.
// ---------------------------------------------------------------------------
export async function createHold(seatIds, sessionId) {
  return withLock(async () => {
    const pg = await getDb();

    // Enforce expiry first so expired holds don't block acquisition.
    const released = await releaseExpiredInternal(pg);

    // Deduplicate and validate input.
    const uniqueIds = [...new Set(seatIds)];

    await pg.query('BEGIN;');
    try {
      // Lock & inspect the requested seats inside the transaction.
      const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');
      const sel = await pg.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders});`,
        uniqueIds
      );

      const found = new Map(sel.rows.map((r) => [r.id, r.status]));

      // Unknown seat ids are treated as conflicts.
      const conflicts = [];
      for (const id of uniqueIds) {
        const status = found.get(id);
        if (status === undefined || status !== 'available') {
          conflicts.push(id);
        }
      }

      if (conflicts.length > 0) {
        await pg.query('ROLLBACK;');
        if (released.length > 0) broadcastSeatUpdate(released);
        return { ok: false, conflicts };
      }

      // Acquire all seats atomically.
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + config.holdTtlMs);
      const expiresIso = expiresAt.toISOString();

      // Placeholders for the UPDATE: seat ids start at $3 ($1=holdId, $2=expiresIso).
      const updPlaceholders = uniqueIds.map((_, i) => `$${i + 3}`).join(', ');

      await pg.query(
        `INSERT INTO holds (id, session_id, expires_at, state)
         VALUES ($1, $2, $3, 'active');`,
        [holdId, sessionId, expiresIso]
      );

      // Conditional update: only flip seats that are still available. The
      // RETURNING count proves all seats were acquired; if it diverges from
      // the requested count we roll back (defensive — the lock prevents races).
      const upd = await pg.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id IN (${updPlaceholders}) AND status = 'available'
          RETURNING id;`,
        [holdId, expiresIso, ...uniqueIds]
      );

      if (upd.rows.length !== uniqueIds.length) {
        await pg.query('ROLLBACK;');
        if (released.length > 0) broadcastSeatUpdate(released);
        return { ok: false, conflicts: uniqueIds };
      }

      await pg.query('COMMIT;');

      const hold = {
        id: holdId,
        sessionId,
        seatIds: uniqueIds,
        expiresAt: expiresIso,
        ttlMs: config.holdTtlMs,
      };

      // Broadcast: the freed (expired) seats + the newly held seats.
      const nowMs = Date.now();
      const heldSeats = uniqueIds.map((id) => ({
        id,
        row: id.replace(/\d+$/, ''),
        number: Number(id.match(/\d+$/)[0]),
        status: 'held',
        holdId,
        holdExpiresAt: expiresIso,
        bookedBy: null,
      }));
      broadcastSeatUpdate([...released, ...heldSeats]);

      return { ok: true, hold };
    } catch (e) {
      try {
        await pg.query('ROLLBACK;');
      } catch (_) {}
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Confirm a hold: book all its seats. Idempotent — confirming an already
// confirmed hold returns the same booking and books nothing additional.
// Rejects unknown or expired holds, booking nothing.
// ---------------------------------------------------------------------------
export async function confirmHold(holdId) {
  return withLock(async () => {
    const pg = await getDb();

    await pg.query('BEGIN;');
    try {
      const holdRes = await pg.query(
        `SELECT id, session_id, expires_at, state FROM holds WHERE id = $1;`,
        [holdId]
      );

      if (holdRes.rows.length === 0) {
        await pg.query('ROLLBACK;');
        return { ok: false, error: 'unknown_hold' };
      }

      const hold = holdRes.rows[0];

      // Idempotency: already confirmed → return the existing booking.
      if (hold.state === 'confirmed') {
        const seatsRes = await pg.query(
          `SELECT id FROM seats WHERE booked_by = $1 AND status = 'booked' ORDER BY id;`,
          [holdId]
        );
        await pg.query('COMMIT;');
        return {
          ok: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: seatsRes.rows.map((r) => r.id),
          },
          idempotent: true,
        };
      }

      // A released hold (cancelled or already expired by sweep) cannot confirm.
      if (hold.state === 'released') {
        await pg.query('ROLLBACK;');
        return { ok: false, error: 'hold_released' };
      }

      // Re-validate expiry inside the transaction.
      const nowMs = Date.now();
      const expMs = new Date(hold.expires_at).getTime();
      if (expMs <= nowMs) {
        // Expired: release its seats now and book nothing.
        const expiredSeats = await pg.query(
          `SELECT id, row_label, seat_number FROM seats WHERE hold_id = $1 AND status = 'held';`,
          [holdId]
        );
        await pg.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held';`,
          [holdId]
        );
        await pg.query(`UPDATE holds SET state = 'released' WHERE id = $1;`, [holdId]);
        await pg.query('COMMIT;');

        const released = expiredSeats.rows.map((r) => ({
          id: r.id,
          row: r.row_label,
          number: r.seat_number,
          status: 'available',
          holdId: null,
          holdExpiresAt: null,
          bookedBy: null,
        }));
        if (released.length > 0) broadcastSeatUpdate(released);
        return { ok: false, error: 'hold_expired' };
      }

      // Active and not expired: verify the hold still owns its seats and book.
      const ownedRes = await pg.query(
        `SELECT id, row_label, seat_number FROM seats
          WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );

      if (ownedRes.rows.length === 0) {
        // Defensive: no seats owned (shouldn't happen for an active hold).
        await pg.query(`UPDATE holds SET state = 'released' WHERE id = $1;`, [holdId]);
        await pg.query('COMMIT;');
        return { ok: false, error: 'no_seats' };
      }

      await pg.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );
      await pg.query(`UPDATE holds SET state = 'confirmed' WHERE id = $1;`, [holdId]);
      await pg.query('COMMIT;');

      const bookedSeats = ownedRes.rows.map((r) => ({
        id: r.id,
        row: r.row_label,
        number: r.seat_number,
        status: 'booked',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: holdId,
      }));
      broadcastSeatUpdate(bookedSeats);

      return {
        ok: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: ownedRes.rows.map((r) => r.id),
        },
        idempotent: false,
      };
    } catch (e) {
      try {
        await pg.query('ROLLBACK;');
      } catch (_) {}
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Release a hold early, returning its seats to available. Idempotent-ish:
// releasing an unknown/confirmed hold is a no-op success for the caller.
// ---------------------------------------------------------------------------
export async function releaseHold(holdId) {
  return withLock(async () => {
    const pg = await getDb();

    await pg.query('BEGIN;');
    try {
      const holdRes = await pg.query(
        `SELECT id, state FROM holds WHERE id = $1;`,
        [holdId]
      );

      if (holdRes.rows.length === 0) {
        await pg.query('ROLLBACK;');
        return { ok: false, error: 'unknown_hold' };
      }

      const hold = holdRes.rows[0];

      if (hold.state === 'confirmed') {
        await pg.query('ROLLBACK;');
        return { ok: false, error: 'already_confirmed' };
      }

      if (hold.state === 'released') {
        await pg.query('COMMIT;');
        return { ok: true, released: [] };
      }

      const seatsRes = await pg.query(
        `SELECT id, row_label, seat_number FROM seats WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );

      await pg.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );
      await pg.query(`UPDATE holds SET state = 'released' WHERE id = $1;`, [holdId]);
      await pg.query('COMMIT;');

      const released = seatsRes.rows.map((r) => ({
        id: r.id,
        row: r.row_label,
        number: r.seat_number,
        status: 'available',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: null,
      }));
      if (released.length > 0) broadcastSeatUpdate(released);
      return { ok: true, released };
    } catch (e) {
      try {
        await pg.query('ROLLBACK;');
      } catch (_) {}
      throw e;
    }
  });
}

// Inventory snapshot for diagnostics / acceptance checking.
export async function getInventory() {
  const seats = await getSeats();
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const s of seats) counts[s.status]++;
  return counts;
}
