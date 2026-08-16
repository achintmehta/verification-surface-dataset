import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from './db.js';
import { config } from './config.js';
import { broadcastSeatUpdates } from './sse.js';

// Shape a raw seat DB row into the public representation, computing the
// *effective* status: a held seat whose hold has expired is reported as
// available.
function toEffectiveSeat(row, now) {
  let status = row.status;
  if (
    status === 'held' &&
    (row.hold_expires_at == null || Number(row.hold_expires_at) <= now)
  ) {
    status = 'available';
  }
  return {
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    bookedBy: status === 'booked' ? row.booked_by : null,
  };
}

// Release all expired holds inside a transaction. Returns the seat rows that
// transitioned back to available so callers can broadcast them. This is the
// lazy-expiry mechanism invoked before every read/hold/confirm and by the
// periodic sweep.
async function releaseExpiredWithin(tx, now) {
  // Mark expired holds and free their seats in one shot. We only touch seats
  // that are still 'held' and tied to an expired hold.
  const { rows } = await tx.query(
    `UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
      WHERE status = 'held'
        AND (hold_expires_at IS NULL OR hold_expires_at <= $1)
      RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
    [now],
  );

  await tx.query(
    `UPDATE holds
        SET status = 'expired'
      WHERE status = 'active' AND expires_at <= $1;`,
    [now],
  );

  return rows;
}

// Public: run expiry sweep (own transaction) and broadcast any releases.
export async function sweepExpired() {
  const now = Date.now();
  const released = await withTransaction((tx) => releaseExpiredWithin(tx, now));
  if (released.length > 0) {
    broadcastSeatUpdates(released.map((r) => toEffectiveSeat(r, now)));
  }
  return released.length;
}

// Read the full seat map with effective statuses. Expiry is enforced first so
// stale holds are reported (and broadcast) as available.
export async function getSeats() {
  await sweepExpired();
  const now = Date.now();
  const { rows } = await getDb().query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      ORDER BY row_label, seat_number;`,
  );
  return rows.map((r) => toEffectiveSeat(r, now));
}

export class BookingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Atomically acquire ALL requested seats only if every one is currently
// available (after expiry). All-or-nothing: on any conflict, acquire none and
// throw a 409 with the conflicting seat ids.
export async function createHold(seatIds, sessionId) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new BookingError(400, 'bad_request', 'seatIds must be a non-empty array');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new BookingError(400, 'bad_request', 'sessionId is required');
  }
  // De-duplicate requested seat ids.
  const uniqueSeatIds = [...new Set(seatIds)];

  const now = Date.now();
  const holdId = randomUUID();
  const expiresAt = now + config.holdTtlMs;

  const { released, hold, heldSeats } = await withTransaction(async (tx) => {
    // 1. Free expired holds first so their seats can be acquired here.
    const expiredReleased = await releaseExpiredWithin(tx, now);

    // 2. Look up the requested seats and verify they all exist & are free.
    const { rows: current } = await tx.query(
      `SELECT id, status, hold_expires_at
         FROM seats
        WHERE id = ANY($1::text[]);`,
      [uniqueSeatIds],
    );

    const foundIds = new Set(current.map((r) => r.id));
    const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new BookingError(404, 'unknown_seats', 'Unknown seat ids', {
        seatIds: missing,
      });
    }

    const conflicts = current
      .filter((r) => {
        if (r.status === 'available') return false;
        // A held-but-expired seat is effectively available (we already freed
        // those above, so this is belt-and-braces).
        if (
          r.status === 'held' &&
          (r.hold_expires_at == null || Number(r.hold_expires_at) <= now)
        ) {
          return false;
        }
        return true;
      })
      .map((r) => r.id);

    if (conflicts.length > 0) {
      throw new BookingError(409, 'seats_unavailable', 'Some seats are unavailable', {
        conflicts,
      });
    }

    // 3. Create the hold row.
    await tx.query(
      `INSERT INTO holds (id, session_id, created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, 'active');`,
      [holdId, sessionId, now, expiresAt],
    );

    // 4. Conditionally acquire the seats. The WHERE clause re-checks
    //    availability so that even if two transactions somehow interleaved,
    //    only seats still available get taken; we then assert we got them all.
    const { rows: acquired } = await tx.query(
      `UPDATE seats
          SET status = 'held',
              hold_id = $1,
              hold_expires_at = $2
        WHERE id = ANY($3::text[])
          AND status = 'available'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
      [holdId, expiresAt, uniqueSeatIds],
    );

    if (acquired.length !== uniqueSeatIds.length) {
      const acquiredIds = new Set(acquired.map((r) => r.id));
      const lost = uniqueSeatIds.filter((id) => !acquiredIds.has(id));
      // Roll back by throwing; the transaction wrapper aborts everything.
      throw new BookingError(409, 'seats_unavailable', 'Some seats are unavailable', {
        conflicts: lost,
      });
    }

    return {
      released: expiredReleased,
      hold: {
        id: holdId,
        sessionId,
        createdAt: now,
        expiresAt,
        seatIds: uniqueSeatIds,
      },
      heldSeats: acquired,
    };
  });

  // Broadcast: expired releases first, then the newly held seats.
  const transitions = [
    ...released.map((r) => toEffectiveSeat(r, now)),
    ...heldSeats.map((r) => toEffectiveSeat(r, now)),
  ];
  broadcastSeatUpdates(transitions);

  return hold;
}

// Confirm a hold: book its seats permanently. Idempotent — a second confirm of
// the same hold returns the same booking and books nothing additional. Expired
// or unknown holds fail and book nothing.
export async function confirmHold(holdId) {
  if (typeof holdId !== 'string' || holdId.trim() === '') {
    throw new BookingError(400, 'bad_request', 'holdId is required');
  }
  const now = Date.now();

  const { booked, hold, alreadyConfirmed } = await withTransaction(async (tx) => {
    // Enforce expiry first.
    await releaseExpiredWithin(tx, now);

    const { rows: holdRows } = await tx.query(
      `SELECT id, session_id, created_at, expires_at, status
         FROM holds
        WHERE id = $1;`,
      [holdId],
    );

    if (holdRows.length === 0) {
      throw new BookingError(404, 'unknown_hold', 'Hold not found');
    }
    const h = holdRows[0];

    // Idempotency: if already confirmed, return its booked seats unchanged.
    if (h.status === 'confirmed') {
      const { rows: seats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          WHERE booked_by = $1 AND status = 'booked'
          ORDER BY row_label, seat_number;`,
        [h.session_id],
      );
      // Only the seats that belonged to this hold: those whose hold_id matched.
      // After booking we clear hold_id, so we track booking via a dedicated
      // lookup by hold. We instead persisted hold_id on booked seats below.
      const { rows: thisHoldSeats } = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          WHERE hold_id = $1 AND status = 'booked'
          ORDER BY row_label, seat_number;`,
        [holdId],
      );
      return {
        booked: thisHoldSeats.length > 0 ? thisHoldSeats : seats,
        hold: h,
        alreadyConfirmed: true,
      };
    }

    if (h.status !== 'active') {
      // released or expired
      throw new BookingError(409, 'hold_expired', 'Hold is no longer active');
    }

    if (Number(h.expires_at) <= now) {
      // Defensive: should already be 'expired' from releaseExpiredWithin.
      throw new BookingError(409, 'hold_expired', 'Hold has expired');
    }

    // Re-validate ownership: book only seats still held by THIS hold.
    const { rows: booked } = await tx.query(
      `UPDATE seats
          SET status = 'booked',
              booked_by = $2,
              hold_expires_at = NULL
        WHERE hold_id = $1
          AND status = 'held'
          AND (hold_expires_at IS NULL OR hold_expires_at > $3)
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
      [holdId, h.session_id, now],
    );

    if (booked.length === 0) {
      throw new BookingError(409, 'hold_invalid', 'Hold owns no bookable seats');
    }

    await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1;`, [holdId]);

    return { booked, hold: h, alreadyConfirmed: false };
  });

  if (!alreadyConfirmed) {
    broadcastSeatUpdates(booked.map((r) => toEffectiveSeat(r, now)));
  }

  return {
    holdId,
    sessionId: hold.session_id,
    booked: booked.map((r) => ({ id: r.id, row: r.row_label, number: r.seat_number })),
    idempotent: alreadyConfirmed,
  };
}

// Release a hold early, returning its seats to available.
export async function releaseHold(holdId) {
  if (typeof holdId !== 'string' || holdId.trim() === '') {
    throw new BookingError(400, 'bad_request', 'holdId is required');
  }
  const now = Date.now();

  const { released, found } = await withTransaction(async (tx) => {
    const { rows: holdRows } = await tx.query(
      `SELECT id, status FROM holds WHERE id = $1;`,
      [holdId],
    );
    if (holdRows.length === 0) {
      return { released: [], found: false };
    }
    const h = holdRows[0];

    if (h.status === 'confirmed') {
      // Cannot release a confirmed (booked) hold.
      throw new BookingError(409, 'already_booked', 'Hold is already confirmed');
    }

    const { rows: freed } = await tx.query(
      `UPDATE seats
          SET status = 'available',
              hold_id = NULL,
              hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
      [holdId],
    );

    await tx.query(
      `UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active';`,
      [holdId],
    );

    return { released: freed, found: true };
  });

  if (!found) {
    throw new BookingError(404, 'unknown_hold', 'Hold not found');
  }

  if (released.length > 0) {
    broadcastSeatUpdates(released.map((r) => toEffectiveSeat(r, now)));
  }

  return { holdId, released: released.map((r) => r.id) };
}

// Inventory snapshot used for diagnostics / acceptance checking.
export async function getInventory() {
  await sweepExpired();
  const now = Date.now();
  const { rows } = await getDb().query(
    `SELECT id, status, hold_expires_at FROM seats;`,
  );
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const r of rows) {
    const eff = toEffectiveSeat(r, now).status;
    if (eff === 'available') available += 1;
    else if (eff === 'held') held += 1;
    else if (eff === 'booked') booked += 1;
  }
  return { total: rows.length, available, held, booked };
}
