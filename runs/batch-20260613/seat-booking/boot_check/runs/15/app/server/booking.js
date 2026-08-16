import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { broadcast } from './sse.js';

export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);

// Serialize all mutating operations through a single async queue so that the
// embedded single-connection PGLite database performs atomic check-and-set
// without interleaving. This is the central correctness guarantee: two
// concurrent hold requests for the same seat cannot both succeed.
let opChain = Promise.resolve();
function withLock(fn) {
  const run = opChain.then(fn, fn);
  // Keep the chain alive even if fn rejects.
  opChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function seatToPublic(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id || null,
    holdExpiresAt: row.hold_expires_at
      ? new Date(row.hold_expires_at).toISOString()
      : null,
  };
}

/**
 * Release any holds whose expires_at is in the past. Returns the list of
 * seat ids that were released so the caller can broadcast them.
 * Must be called while holding the lock (inside withLock).
 */
async function expireStaleHolds(db) {
  const { rows } = await db.query(
    `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_expires_at = NULL
     WHERE status = 'held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= now()
     RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at;`
  );
  await db.query(
    `UPDATE holds SET status = 'expired'
      WHERE status = 'active' AND expires_at <= now();`
  );
  return rows.map(seatToPublic);
}

async function readAllSeats(db) {
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
       FROM seats
      ORDER BY row_label, seat_number;`
  );
  return rows.map(seatToPublic);
}

function broadcastSeats(seats) {
  if (seats.length === 0) return;
  broadcast('seats', { seats });
}

/** Public: get all seats, applying lazy expiry first. */
export async function getSeats() {
  return withLock(async () => {
    const db = await getDb();
    const released = await expireStaleHolds(db);
    broadcastSeats(released);
    return readAllSeats(db);
  });
}

/** Public: aggregate inventory counts (with expiry applied). */
export async function getInventory() {
  return withLock(async () => {
    const db = await getDb();
    await expireStaleHolds(db);
    const { rows } = await db.query(
      `SELECT status, COUNT(*)::int AS c FROM seats GROUP BY status;`
    );
    const inv = { available: 0, held: 0, booked: 0 };
    for (const r of rows) inv[r.status] = r.c;
    inv.total = inv.available + inv.held + inv.booked;
    return inv;
  });
}

/**
 * Atomically place a hold on ALL requested seats. All-or-nothing:
 * if any requested seat is not currently available, no seat is acquired
 * and { ok:false, conflicts:[...] } is returned.
 */
export async function createHold(seatIds, sessionId) {
  return withLock(async () => {
    const db = await getDb();

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      const err = new Error('seatIds must be a non-empty array');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (!sessionId || typeof sessionId !== 'string') {
      const err = new Error('sessionId is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }

    const uniqueIds = [...new Set(seatIds)];

    await db.exec('BEGIN;');
    try {
      // Expire stale holds inside the transaction so a just-expired seat is
      // acquirable here.
      await db.query(
        `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE status = 'held' AND hold_expires_at <= now();`
      );

      // Verify every requested seat exists and is available.
      const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: existing } = await db.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders});`,
        uniqueIds
      );

      const foundIds = new Set(existing.map((r) => r.id));
      const unknown = uniqueIds.filter((id) => !foundIds.has(id));
      const conflicts = existing
        .filter((r) => r.status !== 'available')
        .map((r) => r.id);

      if (unknown.length > 0 || conflicts.length > 0) {
        await db.exec('ROLLBACK;');
        return {
          ok: false,
          conflicts: [...conflicts, ...unknown].sort(),
        };
      }

      const holdId = randomUUID();
      const expiresAtMs = Date.now() + HOLD_TTL_MS;
      const expiresAtIso = new Date(expiresAtMs).toISOString();

      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, $3, 'active');`,
        [holdId, sessionId, expiresAtIso]
      );

      // Conditional update: only flip seats that are still available. If the
      // affected count != requested count, someone raced us -> rollback.
      const { rows: updated } = await db.query(
        `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2
         WHERE id IN (${placeholders.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`)})
           AND status = 'available'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at;`,
        [holdId, expiresAtIso, ...uniqueIds]
      );

      if (updated.length !== uniqueIds.length) {
        await db.exec('ROLLBACK;');
        // recompute conflicts after rollback view
        return {
          ok: false,
          conflicts: uniqueIds
            .filter((id) => !updated.find((u) => u.id === id))
            .sort(),
        };
      }

      await db.exec('COMMIT;');

      const seats = updated.map(seatToPublic);
      broadcastSeats(seats);

      return {
        ok: true,
        hold: {
          id: holdId,
          sessionId,
          seatIds: uniqueIds.sort(),
          expiresAt: expiresAtIso,
          status: 'active',
        },
      };
    } catch (e) {
      try {
        await db.exec('ROLLBACK;');
      } catch {}
      throw e;
    }
  });
}

/**
 * Confirm a hold: book its seats. Transactional and idempotent.
 * - Unknown hold -> { ok:false, reason:'not_found' }
 * - Expired hold -> { ok:false, reason:'expired' } (books nothing)
 * - Already confirmed -> returns the same booking (books nothing additional)
 */
export async function confirmHold(holdId) {
  return withLock(async () => {
    const db = await getDb();

    await db.exec('BEGIN;');
    try {
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at, status FROM holds WHERE id = $1;`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK;');
        return { ok: false, reason: 'not_found' };
      }

      const hold = holdRows[0];

      // Idempotency: already confirmed -> return existing booking.
      if (hold.status === 'confirmed') {
        const { rows: bookedSeats } = await db.query(
          `SELECT id FROM seats WHERE booked_by = $1 ORDER BY id;`,
          [holdId]
        );
        await db.exec('COMMIT;');
        return {
          ok: true,
          alreadyConfirmed: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: bookedSeats.map((r) => r.id),
            status: 'confirmed',
          },
        };
      }

      // Re-validate expiry inside the transaction.
      const nowMs = Date.now();
      const expMs = new Date(hold.expires_at).getTime();
      if (hold.status !== 'active' || expMs <= nowMs) {
        // Release any seats still attached to this expired hold.
        const { rows: released } = await db.query(
          `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at;`,
          [holdId]
        );
        await db.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active';`,
          [holdId]
        );
        await db.exec('COMMIT;');
        broadcastSeats(released.map(seatToPublic));
        return { ok: false, reason: 'expired' };
      }

      // Verify the hold still owns held seats.
      const { rows: ownedSeats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held';`,
        [holdId]
      );
      if (ownedSeats.length === 0) {
        await db.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1;`,
          [holdId]
        );
        await db.exec('COMMIT;');
        return { ok: false, reason: 'expired' };
      }

      // Book the seats.
      const { rows: booked } = await db.query(
        `UPDATE seats
           SET status = 'booked',
               booked_by = $1,
               hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at;`,
        [holdId]
      );
      await db.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1;`,
        [holdId]
      );

      await db.exec('COMMIT;');

      const seats = booked.map(seatToPublic);
      broadcastSeats(seats);

      return {
        ok: true,
        alreadyConfirmed: false,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: booked.map((r) => r.id).sort(),
          status: 'confirmed',
        },
      };
    } catch (e) {
      try {
        await db.exec('ROLLBACK;');
      } catch {}
      throw e;
    }
  });
}

/** Release a hold early; its held seats return to available. */
export async function releaseHold(holdId) {
  return withLock(async () => {
    const db = await getDb();

    await db.exec('BEGIN;');
    try {
      const { rows: holdRows } = await db.query(
        `SELECT id, status FROM holds WHERE id = $1;`,
        [holdId]
      );
      if (holdRows.length === 0) {
        await db.exec('ROLLBACK;');
        return { ok: false, reason: 'not_found' };
      }
      if (holdRows[0].status === 'confirmed') {
        await db.exec('ROLLBACK;');
        return { ok: false, reason: 'already_confirmed' };
      }

      const { rows: released } = await db.query(
        `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at;`,
        [holdId]
      );
      await db.query(
        `UPDATE holds SET status = 'released' WHERE id = $1;`,
        [holdId]
      );
      await db.exec('COMMIT;');

      const seats = released.map(seatToPublic);
      broadcastSeats(seats);
      return { ok: true, releasedSeatIds: seats.map((s) => s.id) };
    } catch (e) {
      try {
        await db.exec('ROLLBACK;');
      } catch {}
      throw e;
    }
  });
}

/** Periodic sweep: release stale holds and broadcast. */
export async function sweepExpired() {
  return withLock(async () => {
    const db = await getDb();
    const released = await expireStaleHolds(db);
    broadcastSeats(released);
    return released.map((s) => s.id);
  });
}
