import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { broadcast } from './sse.js';
import { withLock } from './mutex.js';

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS) || 60 * 1000;

/**
 * Release any expired holds inside the given transaction (tx). Returns the list
 * of seat ids that were released so the caller can broadcast them.
 *
 * A seat is considered to have an expired hold when its status is 'held' and
 * its hold_expires_at is in the past (server clock authoritative).
 */
async function releaseExpiredWithin(tx) {
  const { rows } = await tx.query(
    `UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= now()
      RETURNING id`
  );
  // Mark the corresponding holds as expired/closed so they cannot be confirmed.
  await tx.query(
    `DELETE FROM holds
      WHERE confirmed = FALSE
        AND expires_at <= now()`
  );
  return rows.map((r) => r.id);
}

function effectiveStatusRow(seat) {
  // Defensive: if a held seat's expiry has passed but a sweep hasn't run yet,
  // report it as available.
  if (
    seat.status === 'held' &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at).getTime() <= Date.now()
  ) {
    return {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      booked_by: null,
    };
  }
  return {
    id: seat.id,
    row_label: seat.row_label,
    seat_number: seat.seat_number,
    status: seat.status,
    hold_id: seat.hold_id || null,
    hold_expires_at: seat.hold_expires_at || null,
    booked_by: seat.booked_by || null,
  };
}

/**
 * Sweep expired holds (outside any caller transaction) and broadcast releases.
 */
export async function sweepExpired() {
  const db = getDb();
  const released = await withLock(async () => {
    let r = [];
    await db.transaction(async (tx) => {
      r = await releaseExpiredWithin(tx);
    });
    return r;
  });
  if (released.length > 0) {
    const seats = await getSeatsByIds(released);
    broadcast('released', { seatIds: released, seats });
  }
  return released;
}

export async function getSeatsByIds(ids) {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT * FROM seats WHERE id IN (${placeholders}) ORDER BY row_label, seat_number`,
    ids
  );
  return rows.map(effectiveStatusRow);
}

/**
 * Return all seats with their effective status. Expired holds are reported as
 * available (and lazily released first).
 */
export async function getAllSeats() {
  await sweepExpired();
  const db = getDb();
  const { rows } = await db.query(
    'SELECT * FROM seats ORDER BY row_label, seat_number'
  );
  return rows.map(effectiveStatusRow);
}

/**
 * Atomically acquire ALL requested seats for a session. All-or-nothing.
 *
 * Returns { ok: true, hold } on success, or
 *         { ok: false, conflicts: [seatIds] } on conflict.
 */
export async function createHold(seatIds, sessionId) {
  const db = getDb();
  const uniqueIds = [...new Set(seatIds)];
  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

  let result;
  let releasedFromExpiry = [];

  await withLock(() => db.transaction(async (tx) => {
    // First release expired holds so their seats are acquirable.
    releasedFromExpiry = await releaseExpiredWithin(tx);

    // Lock and read the requested seats. FOR UPDATE serializes concurrent
    // transactions touching the same rows so the check-and-set is atomic.
    const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: targets } = await tx.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      uniqueIds
    );

    const foundIds = new Set(targets.map((t) => t.id));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));

    // Any seat not currently available (or not existing) is a conflict.
    const conflicts = [
      ...missing,
      ...targets.filter((t) => t.status !== 'available').map((t) => t.id),
    ];

    if (conflicts.length > 0) {
      result = { ok: false, conflicts };
      return; // transaction commits the expiry releases, acquires nothing else
    }

    // Create the hold and mark all seats held in one shot.
    await tx.query(
      'INSERT INTO holds (id, session_id, expires_at, confirmed) VALUES ($1, $2, $3::timestamptz, FALSE)',
      [holdId, sessionId, expiresAt.toISOString()]
    );
    // Placeholders for the seat ids must be offset past $1 (hold_id) and
    // $2 (expires_at).
    const updatePlaceholders = uniqueIds.map((_, i) => `$${i + 3}`).join(',');
    await tx.query(
      `UPDATE seats
          SET status = 'held', hold_id = $1, hold_expires_at = $2::timestamptz
        WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt.toISOString(), ...uniqueIds]
    );

    result = {
      ok: true,
      hold: {
        id: holdId,
        sessionId,
        seatIds: uniqueIds,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }));

  // Broadcast expiry releases that happened during this op.
  if (releasedFromExpiry.length > 0) {
    const seats = await getSeatsByIds(releasedFromExpiry);
    broadcast('released', { seatIds: releasedFromExpiry, seats });
  }

  if (result.ok) {
    const seats = await getSeatsByIds(result.hold.seatIds);
    broadcast('held', { holdId, seatIds: result.hold.seatIds, seats });
  }

  return result;
}

/**
 * Confirm a hold: book all its seats. Idempotent — confirming an already
 * confirmed hold returns the same booking and books nothing additional.
 *
 * Returns { ok: true, booking } or { ok: false, error }.
 */
export async function confirmHold(holdId) {
  const db = getDb();
  let result;
  let releasedFromExpiry = [];
  let newlyBooked = [];

  await withLock(() => db.transaction(async (tx) => {
    releasedFromExpiry = await releaseExpiredWithin(tx);

    // Lock the hold row.
    const { rows: holds } = await tx.query(
      'SELECT * FROM holds WHERE id = $1 FOR UPDATE',
      [holdId]
    );

    if (holds.length === 0) {
      result = { ok: false, error: 'Hold not found or expired' };
      return;
    }
    const hold = holds[0];

    // Idempotency: if already confirmed, return the existing booking.
    if (hold.confirmed) {
      const { rows: bookedSeats } = await tx.query(
        'SELECT id FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY id',
        [holdId, 'booked']
      );
      result = {
        ok: true,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: bookedSeats.map((s) => s.id),
        },
        idempotent: true,
      };
      return;
    }

    // Re-validate expiry inside the transaction.
    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      // Release any seats still pointing at this hold.
      await tx.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await tx.query('DELETE FROM holds WHERE id = $1', [holdId]);
      result = { ok: false, error: 'Hold expired' };
      return;
    }

    // Lock the held seats and verify ownership.
    const { rows: heldSeats } = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (heldSeats.length === 0) {
      result = { ok: false, error: 'No seats are held by this hold' };
      return;
    }

    const seatIds = heldSeats.map((s) => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    await tx.query(
      `UPDATE seats
          SET status = 'booked', booked_by = $1, hold_expires_at = NULL
        WHERE id IN (${placeholders})`,
      [hold.session_id, ...seatIds]
    );
    await tx.query('UPDATE holds SET confirmed = TRUE WHERE id = $1', [holdId]);

    newlyBooked = seatIds;
    result = {
      ok: true,
      booking: { holdId, sessionId: hold.session_id, seatIds },
    };
  }));

  if (releasedFromExpiry.length > 0) {
    const seats = await getSeatsByIds(releasedFromExpiry);
    broadcast('released', { seatIds: releasedFromExpiry, seats });
  }
  if (newlyBooked.length > 0) {
    const seats = await getSeatsByIds(newlyBooked);
    broadcast('booked', { holdId, seatIds: newlyBooked, seats });
  }

  return result;
}

/**
 * Release a hold early, returning its (held) seats to available. Booked seats
 * are never released.
 */
export async function releaseHold(holdId) {
  const db = getDb();
  let releasedSeatIds = [];

  await withLock(() => db.transaction(async (tx) => {
    const { rows: holds } = await tx.query(
      'SELECT * FROM holds WHERE id = $1 FOR UPDATE',
      [holdId]
    );
    if (holds.length === 0) return;
    const hold = holds[0];
    if (hold.confirmed) return; // cannot release a confirmed booking

    const { rows } = await tx.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
      RETURNING id`,
      [holdId]
    );
    releasedSeatIds = rows.map((r) => r.id);
    await tx.query('DELETE FROM holds WHERE id = $1', [holdId]);
  }));

  if (releasedSeatIds.length > 0) {
    const seats = await getSeatsByIds(releasedSeatIds);
    broadcast('released', { seatIds: releasedSeatIds, seats });
  }

  return { ok: true, seatIds: releasedSeatIds };
}

/**
 * Inventory summary used by tests / monitoring. Counts use effective status.
 */
export async function getInventory() {
  const seats = await getAllSeats();
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of seats) counts[s.status]++;
  return { ...counts, total: seats.length };
}
