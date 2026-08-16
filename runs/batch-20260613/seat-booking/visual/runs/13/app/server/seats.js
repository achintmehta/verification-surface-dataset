import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { broadcast } from './sse.js';

export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS) || 60_000; // hold TTL

// A single in-process mutex serializes all seat-mutating operations.
// PGlite runs a single embedded Postgres; serializing acquisition here
// gives us strict all-or-nothing atomicity across the multi-seat check-and-set.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  // keep the chain alive regardless of individual rejections
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * Release any holds whose expires_at has passed. Returns the list of seat
 * ids that became available so callers can broadcast the transitions.
 * Must be called inside withLock.
 */
async function expireStaleHolds(db) {
  // Find seats that are held by an expired hold.
  const { rows: expiredSeats } = await db.query(
    `SELECT id FROM seats
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()`
  );

  if (expiredSeats.length === 0) return [];

  await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()`
  );

  await db.query(
    `UPDATE holds SET status = 'expired'
      WHERE status = 'active' AND expires_at <= now()`
  );

  return expiredSeats.map((s) => s.id);
}

function broadcastReleases(seatIds) {
  if (seatIds.length) {
    broadcast('seats', { seats: seatIds.map((id) => ({ id, status: 'available' })) });
  }
}

/**
 * Return every seat with its effective status. Expired holds are released
 * (and broadcast) before reading so the reported status is always exact.
 */
export async function getSeats() {
  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);
    broadcastReleases(released);

    const { rows } = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
        ORDER BY row_label, seat_number`
    );
    return rows.map((r) => ({
      id: r.id,
      row: r.row_label,
      number: r.seat_number,
      status: r.status,
      holdId: r.hold_id,
      holdExpiresAt: r.hold_expires_at ? new Date(r.hold_expires_at).getTime() : null,
      bookedBy: r.booked_by,
    }));
  });
}

/**
 * Atomically acquire ALL requested seats for a session. All-or-nothing:
 * if any seat is unavailable, none are acquired and we return the conflicts.
 */
export async function createHold(seatIds, sessionId) {
  return withLock(async () => {
    const db = getDb();

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return { ok: false, error: 'seatIds must be a non-empty array', status: 400 };
    }
    if (!sessionId) {
      return { ok: false, error: 'sessionId is required', status: 400 };
    }
    // Deduplicate.
    const ids = [...new Set(seatIds)];

    const released = await expireStaleHolds(db);

    let result;
    try {
      await db.exec('BEGIN');

      // Validate every requested seat exists and check availability.
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seatRows } = await db.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders})`,
        ids
      );

      const found = new Map(seatRows.map((s) => [s.id, s.status]));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        await db.exec('ROLLBACK');
        broadcastReleases(released);
        return { ok: false, error: 'Unknown seat(s)', conflicts: missing, status: 400 };
      }

      const conflicts = ids.filter((id) => found.get(id) !== 'available');
      if (conflicts.length) {
        await db.exec('ROLLBACK');
        broadcastReleases(released);
        return {
          ok: false,
          error: 'One or more seats are unavailable',
          conflicts,
          status: 409,
        };
      }

      const holdId = randomUUID();
      const expiresAtMs = Date.now() + HOLD_TTL_MS;

      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), 'active')`,
        [holdId, sessionId, expiresAtMs]
      );

      // Conditional update guards against any concurrent change.
      const { rows: updated } = await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = to_timestamp($2 / 1000.0)
          WHERE id IN (${placeholders.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`)})
            AND status = 'available'
          RETURNING id`,
        [holdId, expiresAtMs, ...ids]
      );

      if (updated.length !== ids.length) {
        // Lost a race; abort entirely.
        await db.exec('ROLLBACK');
        broadcastReleases(released);
        return {
          ok: false,
          error: 'One or more seats are unavailable',
          conflicts: ids.filter((id) => !updated.find((u) => u.id === id)),
          status: 409,
        };
      }

      await db.exec('COMMIT');
      result = {
        ok: true,
        hold: { id: holdId, sessionId, seatIds: ids, expiresAt: expiresAtMs },
      };
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch {}
      throw err;
    }

    broadcastReleases(released);
    broadcast('seats', {
      seats: ids.map((id) => ({ id, status: 'held' })),
    });
    return result;
  });
}

/**
 * Confirm a hold: book its seats. Idempotent — a second confirm returns the
 * same booking and books nothing additional. Expired/unknown holds fail.
 */
export async function confirmHold(holdId) {
  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);

    let result;
    try {
      await db.exec('BEGIN');

      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, status, expires_at FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        await db.exec('ROLLBACK');
        broadcastReleases(released);
        return { ok: false, error: 'Unknown hold', status: 404 };
      }

      const hold = holdRows[0];

      // Idempotency: already confirmed -> return existing booking.
      if (hold.status === 'confirmed') {
        const { rows: booked } = await db.query(
          `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
          [holdId]
        );
        await db.exec('COMMIT');
        broadcastReleases(released);
        return {
          ok: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: booked.map((b) => b.id),
          },
          idempotent: true,
        };
      }

      if (hold.status !== 'active') {
        await db.exec('ROLLBACK');
        broadcastReleases(released);
        return { ok: false, error: 'Hold is no longer active', status: 409 };
      }

      // Re-validate expiry inside the transaction.
      const { rows: expCheck } = await db.query(
        `SELECT (expires_at <= now()) AS expired FROM holds WHERE id = $1`,
        [holdId]
      );
      if (expCheck[0].expired) {
        // Release its seats and mark expired.
        const { rows: heldSeats } = await db.query(
          `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await db.query(
          `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL
            WHERE hold_id = $1 AND status='held'`,
          [holdId]
        );
        await db.query(`UPDATE holds SET status='expired' WHERE id=$1`, [holdId]);
        await db.exec('COMMIT');
        broadcastReleases(released);
        broadcastReleases(heldSeats.map((s) => s.id));
        return { ok: false, error: 'Hold has expired', status: 409 };
      }

      // Book the seats this hold currently owns.
      const { rows: bookedSeats } = await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1, hold_expires_at = NULL
          WHERE hold_id = $2 AND status = 'held'
          RETURNING id`,
        [hold.session_id, holdId]
      );

      await db.query(`UPDATE holds SET status='confirmed' WHERE id=$1`, [holdId]);
      await db.exec('COMMIT');

      result = {
        ok: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: bookedSeats.map((b) => b.id),
        },
      };
      broadcastReleases(released);
      broadcast('seats', {
        seats: result.booking.seatIds.map((id) => ({ id, status: 'booked' })),
      });
      return result;
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  });
}

/**
 * Release an active hold early, returning its seats to available.
 */
export async function releaseHold(holdId) {
  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);

    const { rows: holdRows } = await db.query(
      `SELECT id, status FROM holds WHERE id = $1`,
      [holdId]
    );
    if (holdRows.length === 0) {
      broadcastReleases(released);
      return { ok: false, error: 'Unknown hold', status: 404 };
    }
    if (holdRows[0].status !== 'active') {
      broadcastReleases(released);
      return { ok: false, error: 'Hold is not active', status: 409 };
    }

    const { rows: seats } = await db.query(
      `UPDATE seats
          SET status='available', hold_id=NULL, hold_expires_at=NULL
        WHERE hold_id = $1 AND status='held'
        RETURNING id`,
      [holdId]
    );
    await db.query(`UPDATE holds SET status='released' WHERE id=$1`, [holdId]);

    broadcastReleases(released);
    broadcastReleases(seats.map((s) => s.id));
    return { ok: true, released: seats.map((s) => s.id) };
  });
}

/**
 * Periodic sweep: release any stale holds and broadcast.
 */
export async function sweep() {
  return withLock(async () => {
    const db = getDb();
    const released = await expireStaleHolds(db);
    broadcastReleases(released);
    return released;
  });
}

/**
 * Inventory accounting helper used by tests / health endpoint.
 */
export async function inventory() {
  return withLock(async () => {
    const db = getDb();
    await expireStaleHolds(db);
    const { rows } = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
    );
    const counts = { available: 0, held: 0, booked: 0 };
    for (const r of rows) counts[r.status] = r.count;
    return counts;
  });
}
