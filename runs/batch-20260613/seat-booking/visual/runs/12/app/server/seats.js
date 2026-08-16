import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { broadcast } from './sse.js';
import { HOLD_TTL_MS } from './config.js';

// ---------------------------------------------------------------------------
// Concurrency model
// ---------------------------------------------------------------------------
// PGLite runs a single embedded Postgres instance and serializes statements,
// but a logical "hold" operation spans several statements. To guarantee
// all-or-nothing acquisition under concurrent requests we run each mutating
// operation inside a single transaction AND serialize those transactions with
// an in-process async mutex. This makes every hold/confirm/release/sweep
// atomic with respect to one another, which is exactly the correctness
// guarantee the spec demands ("exactly one succeeds").

let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of success/failure.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Effective-status helpers
// ---------------------------------------------------------------------------

// Map a raw DB row to its effective public representation. A held seat whose
// hold has expired is reported as available.
function toEffective(row, now = Date.now()) {
  let status = row.status;
  if (
    status === 'held' &&
    row.hold_expires_at &&
    new Date(row.hold_expires_at).getTime() <= now
  ) {
    status = 'available';
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    holdExpiresAt:
      status === 'held' && row.hold_expires_at
        ? new Date(row.hold_expires_at).toISOString()
        : null,
    bookedBy: status === 'booked' ? row.booked_by : null
  };
}

// Release any expired holds inside the current transaction. Returns the rows
// that were released so callers can broadcast them.
async function releaseExpired(db) {
  const { rows } = await db.query(
    `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE status = 'held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= now()
     RETURNING *;`
  );
  return rows;
}

function broadcastSeats(event, rows) {
  if (!rows || rows.length === 0) return;
  const seats = rows.map((r) => toEffective(r));
  broadcast(event, { seats });
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

// Return the full seat map with effective statuses. Also lazily releases
// expired holds and broadcasts those releases.
export async function listSeats() {
  return withLock(async () => {
    const db = getDb();
    const released = await releaseExpired(db);
    if (released.length) broadcastSeats('released', released);

    const { rows } = await db.query(
      'SELECT * FROM seats ORDER BY row_label, seat_number;'
    );
    return rows.map((r) => toEffective(r));
  });
}

// Atomically acquire ALL requested seats. All-or-nothing: if any requested
// seat is unavailable, none are acquired and a conflict is returned.
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { ok: false, status: 400, error: 'seatIds must be a non-empty array' };
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, status: 400, error: 'sessionId is required' };
  }
  // De-duplicate requested seats.
  const requested = [...new Set(seatIds.map(String))];

  return withLock(async () => {
    const db = getDb();
    await db.query('BEGIN;');
    try {
      // Release expired holds first so freshly-expired seats are acquirable.
      const released = await releaseExpired(db);

      // Validate the requested seats exist.
      const { rows: existing } = await db.query(
        `SELECT * FROM seats WHERE id = ANY($1::text[]);`,
        [requested]
      );
      const foundIds = new Set(existing.map((r) => r.id));
      const missing = requested.filter((id) => !foundIds.has(id));
      if (missing.length) {
        await db.query('ROLLBACK;');
        return {
          ok: false,
          status: 404,
          error: 'Unknown seat ids',
          unknownSeatIds: missing
        };
      }

      // Determine conflicts: any requested seat not currently available.
      const conflicts = existing
        .filter((r) => r.status !== 'available')
        .map((r) => r.id);
      if (conflicts.length) {
        await db.query('ROLLBACK;');
        // We rolled back the release; broadcast it after commit-less path by
        // re-applying releases (they were valid). Simpler: re-run release in a
        // fresh tx so clients still learn about expirations.
        if (released.length) {
          await db.query('BEGIN;');
          const r2 = await releaseExpired(db);
          await db.query('COMMIT;');
          broadcastSeats('released', r2);
        }
        return {
          ok: false,
          status: 409,
          error: 'One or more seats are no longer available',
          conflictSeatIds: conflicts
        };
      }

      // Acquire: conditional update guarded by status='available'. Because we
      // are inside the serialized lock + transaction, the count must equal the
      // number requested or we abort (defensive double-check).
      const holdId = randomUUID();
      const expiresAtMs = Date.now() + HOLD_TTL_MS;
      const expiresAt = new Date(expiresAtMs).toISOString();

      const { rows: updated } = await db.query(
        `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2
         WHERE id = ANY($3::text[])
           AND status = 'available'
         RETURNING *;`,
        [holdId, expiresAt, requested]
      );

      if (updated.length !== requested.length) {
        // Should not happen under the lock, but never partially acquire.
        await db.query('ROLLBACK;');
        return {
          ok: false,
          status: 409,
          error: 'Seat acquisition race detected',
          conflictSeatIds: requested
        };
      }

      await db.query('COMMIT;');

      if (released.length) broadcastSeats('released', released);
      broadcastSeats('held', updated);

      return {
        ok: true,
        status: 201,
        hold: {
          holdId,
          sessionId,
          seatIds: requested,
          expiresAt,
          expiresInMs: Math.max(0, expiresAtMs - Date.now())
        }
      };
    } catch (err) {
      try {
        await db.query('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Confirm a hold: book its seats. Idempotent. Rejects expired/unknown holds.
export async function confirmHold(holdId) {
  if (!holdId) {
    return { ok: false, status: 400, error: 'holdId is required' };
  }

  return withLock(async () => {
    const db = getDb();
    await db.query('BEGIN;');
    try {
      // First, release expired holds (this may invalidate the target hold).
      const released = await releaseExpired(db);

      // Look for seats already booked under this hold (idempotent path).
      const { rows: alreadyBooked } = await db.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked';`,
        [holdId]
      );
      if (alreadyBooked.length) {
        await db.query('COMMIT;');
        if (released.length) broadcastSeats('released', released);
        return {
          ok: true,
          status: 200,
          alreadyConfirmed: true,
          booking: {
            holdId,
            seatIds: alreadyBooked.map((r) => r.id),
            bookedBy: alreadyBooked[0].booked_by
          }
        };
      }

      // Otherwise the hold must still be actively held (not expired).
      const { rows: heldSeats } = await db.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        await db.query('COMMIT;');
        if (released.length) broadcastSeats('released', released);
        return {
          ok: false,
          status: 410,
          error: 'Hold is expired, already released, or unknown',
          holdId
        };
      }

      // Re-validate expiry defensively (releaseExpired should have handled it).
      const now = Date.now();
      const expired = heldSeats.some(
        (r) =>
          r.hold_expires_at && new Date(r.hold_expires_at).getTime() <= now
      );
      if (expired) {
        // Release them and report failure.
        const { rows: rel } = await db.query(
          `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING *;`,
          [holdId]
        );
        await db.query('COMMIT;');
        broadcastSeats('released', [...released, ...rel]);
        return {
          ok: false,
          status: 410,
          error: 'Hold expired before confirmation',
          holdId
        };
      }

      // Book: derive a stable booked_by identity from the hold.
      const bookedBy = holdId;
      const { rows: booked } = await db.query(
        `UPDATE seats
           SET status = 'booked', booked_by = $2, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING *;`,
        [holdId, bookedBy]
      );

      await db.query('COMMIT;');

      if (released.length) broadcastSeats('released', released);
      broadcastSeats('booked', booked);

      return {
        ok: true,
        status: 200,
        booking: {
          holdId,
          seatIds: booked.map((r) => r.id),
          bookedBy
        }
      };
    } catch (err) {
      try {
        await db.query('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Release a hold early, returning its (still-held) seats to available.
export async function releaseHold(holdId) {
  if (!holdId) {
    return { ok: false, status: 400, error: 'holdId is required' };
  }

  return withLock(async () => {
    const db = getDb();
    await db.query('BEGIN;');
    try {
      const expired = await releaseExpired(db);
      const { rows: released } = await db.query(
        `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING *;`,
        [holdId]
      );
      await db.query('COMMIT;');

      const all = [...expired, ...released];
      if (all.length) broadcastSeats('released', all);

      if (released.length === 0) {
        return {
          ok: false,
          status: 404,
          error: 'No active hold found for this id',
          holdId
        };
      }
      return { ok: true, status: 200, releasedSeatIds: released.map((r) => r.id) };
    } catch (err) {
      try {
        await db.query('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Background sweep: release stale holds and broadcast.
export async function sweepExpired() {
  return withLock(async () => {
    const db = getDb();
    await db.query('BEGIN;');
    try {
      const released = await releaseExpired(db);
      await db.query('COMMIT;');
      if (released.length) broadcastSeats('released', released);
      return released.length;
    } catch (err) {
      try {
        await db.query('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

// Inventory summary used for diagnostics / acceptance checks.
export async function inventory() {
  return withLock(async () => {
    const db = getDb();
    const released = await releaseExpired(db);
    if (released.length) broadcastSeats('released', released);
    const { rows } = await db.query('SELECT * FROM seats;');
    const now = Date.now();
    let available = 0;
    let held = 0;
    let booked = 0;
    for (const r of rows) {
      const e = toEffective(r, now);
      if (e.status === 'available') available++;
      else if (e.status === 'held') held++;
      else booked++;
    }
    return { total: rows.length, available, held, booked };
  });
}
