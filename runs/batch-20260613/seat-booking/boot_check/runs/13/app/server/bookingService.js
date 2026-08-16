import crypto from 'node:crypto';
import { getDb } from './db.js';
import { broadcastSeatUpdates } from './sse.js';

const HOLD_TTL_MS = parseInt(process.env.HOLD_TTL_MS || '60000', 10); // 60s default

// Serialize all write operations to guarantee atomic check-and-set semantics.
// PGLite runs in-process and single-threaded, but requests are async; this
// mutex prevents interleaving of the multi-statement transactions that
// implement hold/confirm/release/expiry.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  // keep the chain alive even if fn rejects
  chain = run.then(() => {}, () => {});
  return run;
}

function publicSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id || null,
    holdExpiresAt: row.hold_expires_at || null,
  };
}

// Release any holds that have expired. Returns list of affected seats (public form).
// Must be called inside withLock (or at least serialized).
async function releaseExpiredHolds(db) {
  // Find held seats whose hold has expired.
  const res = await db.query(
    `SELECT id, row_label, seat_number FROM seats
       WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= now()`
  );
  if (res.rows.length === 0) return [];

  await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= now()`
  );
  await db.query(
    `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()`
  );

  // Re-fetch affected seats for accurate public state.
  const ids = res.rows.map((r) => r.id);
  const updated = await db.query(
    `SELECT * FROM seats WHERE id = ANY($1::text[])`,
    [ids]
  );
  return updated.rows.map(publicSeat);
}

export async function getSeats() {
  const db = await getDb();
  return withLock(async () => {
    const released = await releaseExpiredHolds(db);
    if (released.length) broadcastSeatUpdates(released);
    const res = await db.query(
      `SELECT * FROM seats ORDER BY row_label, seat_number`
    );
    return res.rows.map(publicSeat);
  });
}

export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.statusCode = 400;
    throw err;
  }
  if (!sessionId || typeof sessionId !== 'string') {
    const err = new Error('sessionId is required');
    err.statusCode = 400;
    throw err;
  }
  // de-dup
  const requested = [...new Set(seatIds)];

  const db = await getDb();
  return withLock(async () => {
    const released = await releaseExpiredHolds(db);

    await db.query('BEGIN');
    try {
      // Lock & fetch the requested seats.
      const existing = await db.query(
        `SELECT * FROM seats WHERE id = ANY($1::text[]) FOR UPDATE`,
        [requested]
      );

      const foundIds = new Set(existing.rows.map((r) => r.id));
      const missing = requested.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        await db.query('ROLLBACK');
        const err = new Error('Unknown seat ids');
        err.statusCode = 404;
        err.payload = { unknownSeatIds: missing };
        throw err;
      }

      // Determine conflicts: any seat not effectively available.
      const conflicts = [];
      const nowRes = await db.query('SELECT now() AS now');
      const now = new Date(nowRes.rows[0].now).getTime();
      for (const seat of existing.rows) {
        let effectivelyAvailable = seat.status === 'available';
        if (
          seat.status === 'held' &&
          seat.hold_expires_at &&
          new Date(seat.hold_expires_at).getTime() <= now
        ) {
          effectivelyAvailable = true; // expired hold
        }
        if (!effectivelyAvailable) {
          conflicts.push(seat.id);
        }
      }

      if (conflicts.length > 0) {
        await db.query('ROLLBACK');
        const err = new Error('Some seats are unavailable');
        err.statusCode = 409;
        err.payload = { conflictingSeatIds: conflicts };
        throw err;
      }

      // All available -> acquire all.
      const holdId = crypto.randomUUID();
      const expiresRes = await db.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'), 'active')
         RETURNING expires_at`,
        [holdId, sessionId, HOLD_TTL_MS]
      );
      const expiresAt = expiresRes.rows[0].expires_at;

      await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id = ANY($3::text[])`,
        [holdId, expiresAt, requested]
      );

      await db.query('COMMIT');

      const updated = await db.query(
        `SELECT * FROM seats WHERE id = ANY($1::text[])`,
        [requested]
      );
      const updatedPublic = updated.rows.map(publicSeat);

      // Broadcast: released expired (from sweep) + newly held.
      const all = [...released, ...updatedPublic];
      broadcastSeatUpdates(all);

      return {
        holdId,
        sessionId,
        seatIds: requested,
        expiresAt,
        ttlMs: HOLD_TTL_MS,
      };
    } catch (e) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {}
      // broadcast any releases that happened during the sweep before failure
      if (released.length) broadcastSeatUpdates(released);
      throw e;
    }
  });
}

export async function confirmHold(holdId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }
  const db = await getDb();
  return withLock(async () => {
    const released = await releaseExpiredHolds(db);
    if (released.length) broadcastSeatUpdates(released);

    await db.query('BEGIN');
    try {
      const holdRes = await db.query(
        `SELECT * FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );
      if (holdRes.rows.length === 0) {
        await db.query('ROLLBACK');
        const err = new Error('Unknown hold');
        err.statusCode = 404;
        throw err;
      }
      const hold = holdRes.rows[0];

      // Idempotency: if already confirmed, return the existing booking.
      if (hold.status === 'confirmed') {
        // Find seats booked by this hold.
        const bookedSeats = await db.query(
          `SELECT * FROM seats WHERE status = 'booked' AND hold_id = $1 ORDER BY row_label, seat_number`,
          [holdId]
        );
        await db.query('COMMIT');
        return {
          holdId,
          sessionId: hold.session_id,
          status: 'confirmed',
          seatIds: bookedSeats.rows.map((r) => r.id),
          alreadyConfirmed: true,
        };
      }

      // Check expiry.
      const nowRes = await db.query('SELECT now() AS now');
      const now = new Date(nowRes.rows[0].now).getTime();
      if (
        hold.status === 'expired' ||
        new Date(hold.expires_at).getTime() <= now
      ) {
        // mark expired and release any seats still pointing to it
        await db.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        const relSeats = await db.query(
          `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await db.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
             WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await db.query('COMMIT');
        const relPublic = relSeats.rows.map((r) => ({ ...publicSeat(r), status: 'available', holdId: null, holdExpiresAt: null }));
        if (relPublic.length) broadcastSeatUpdates(relPublic);
        const err = new Error('Hold has expired');
        err.statusCode = 410;
        throw err;
      }

      // Active hold: verify it owns held seats, then book them.
      const heldSeats = await db.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
        [holdId]
      );
      if (heldSeats.rows.length === 0) {
        // Hold active but owns no seats (shouldn't normally happen).
        await db.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);
        await db.query('COMMIT');
        return {
          holdId,
          sessionId: hold.session_id,
          status: 'confirmed',
          seatIds: [],
        };
      }

      await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1, hold_expires_at = NULL
          WHERE hold_id = $2 AND status = 'held'`,
        [hold.session_id, holdId]
      );
      await db.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );
      await db.query('COMMIT');

      const ids = heldSeats.rows.map((r) => r.id);
      const updated = await db.query(
        `SELECT * FROM seats WHERE id = ANY($1::text[])`,
        [ids]
      );
      const updatedPublic = updated.rows.map(publicSeat);
      broadcastSeatUpdates(updatedPublic);

      return {
        holdId,
        sessionId: hold.session_id,
        status: 'confirmed',
        seatIds: ids,
      };
    } catch (e) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {}
      throw e;
    }
  });
}

export async function releaseHold(holdId) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.statusCode = 400;
    throw err;
  }
  const db = await getDb();
  return withLock(async () => {
    await db.query('BEGIN');
    try {
      const holdRes = await db.query(
        `SELECT * FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );
      if (holdRes.rows.length === 0) {
        await db.query('ROLLBACK');
        const err = new Error('Unknown hold');
        err.statusCode = 404;
        throw err;
      }
      const hold = holdRes.rows[0];

      if (hold.status === 'confirmed') {
        await db.query('ROLLBACK');
        const err = new Error('Hold already confirmed; cannot release booked seats');
        err.statusCode = 409;
        throw err;
      }

      const heldSeats = await db.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await db.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );
      await db.query('COMMIT');

      const relPublic = heldSeats.rows.map((r) => ({
        ...publicSeat(r),
        status: 'available',
        holdId: null,
        holdExpiresAt: null,
      }));
      if (relPublic.length) broadcastSeatUpdates(relPublic);

      return { holdId, released: true, seatIds: heldSeats.rows.map((r) => r.id) };
    } catch (e) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {}
      throw e;
    }
  });
}

// Periodic sweep that releases stale holds and broadcasts.
export async function sweepExpired() {
  const db = await getDb();
  return withLock(async () => {
    const released = await releaseExpiredHolds(db);
    if (released.length) broadcastSeatUpdates(released);
    return released;
  });
}

export { HOLD_TTL_MS };
