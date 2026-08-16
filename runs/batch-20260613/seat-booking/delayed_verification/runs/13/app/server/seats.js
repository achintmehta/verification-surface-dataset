import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { withLock } from './locks.js';
import { broadcastSeatUpdates } from './sse.js';
import { HOLD_TTL_MS } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shape a raw seat DB row into the API representation.
function shapeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at
      ? new Date(row.hold_expires_at).toISOString()
      : null,
    bookedBy: row.booked_by
  };
}

// Release every hold whose expires_at has passed. Must be called inside a
// transaction (or while holding the lock). Returns the list of seat updates
// produced so the caller can broadcast them.
//
// This is the single source of truth for expiry: it runs before every
// hold/confirm/release operation and on every seat read, and also from the
// periodic sweep. We never trust a client timer to free inventory.
async function expireStaleHolds(db) {
  // Mark expired active holds as released.
  await db.query(
    `UPDATE holds
       SET status = 'released'
     WHERE status = 'active'
       AND expires_at <= now()`
  );

  // Free seats whose hold is no longer active (expired/released). Only touch
  // seats that are currently 'held' and whose hold_id is not an active hold.
  const { rows } = await db.query(
    `UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
      WHERE status = 'held'
        AND (
          hold_id IS NULL
          OR hold_id NOT IN (SELECT id FROM holds WHERE status = 'active')
        )
      RETURNING *`
  );
  return rows.map(shapeSeat);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Return the full seat map. Expiry is enforced first so any seat whose hold
// has elapsed is reported as available. Releases are broadcast.
export async function getSeatMap() {
  const db = await getDb();
  return withLock(async () => {
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length) broadcastSeatUpdates(released);

    const { rows } = await db.query(
      `SELECT * FROM seats ORDER BY row_label, seat_number`
    );
    return rows.map(shapeSeat);
  });
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

// Atomically acquire ALL requested seats for a session. All-or-nothing:
// if any requested seat is not available the whole request fails with the
// conflicting seat ids and nothing is acquired.
export async function createHold(seatIds, sessionId) {
  const db = await getDb();

  // Validate / normalize input.
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
  // Deduplicate while preserving order.
  const ids = [...new Set(seatIds)];

  return withLock(async () => {
    let result;
    let releasedDuringExpiry = [];
    let heldUpdates = [];

    await db.transaction(async (tx) => {
      // Enforce expiry first so newly-freed seats are acquirable.
      releasedDuringExpiry = await expireStaleHolds(tx);

      // Read the current state of exactly the requested seats.
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: current } = await tx.query(
        `SELECT * FROM seats WHERE id IN (${placeholders})`,
        ids
      );

      // Detect unknown seat ids.
      const found = new Set(current.map((r) => r.id));
      const unknown = ids.filter((id) => !found.has(id));
      if (unknown.length) {
        result = { ok: false, code: 'UNKNOWN_SEATS', unknown };
        return; // transaction commits but nothing changed
      }

      // Determine conflicts: any seat not currently available cannot be held.
      const conflicts = current
        .filter((r) => r.status !== 'available')
        .map((r) => r.id);

      if (conflicts.length) {
        // All-or-nothing: acquire none.
        result = { ok: false, code: 'CONFLICT', conflicts };
        return;
      }

      // All seats available: create the hold and mark seats held.
      const holdId = randomUUID();
      const expiresAtMs = Date.now() + HOLD_TTL_MS;
      const expiresAtIso = new Date(expiresAtMs).toISOString();

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, $3::timestamptz, 'active')`,
        [holdId, sessionId, expiresAtIso]
      );

      // Conditional update: only flip seats that are still available. Because
      // we hold the process lock and ran expiry inside this same transaction,
      // the WHERE guard re-verifies availability atomically.
      // Placeholders for the seat ids are offset by 2 ($1=holdId, $2=expiresAt).
      const updatePlaceholders = ids.map((_, i) => `$${i + 3}`).join(', ');
      const { rows: updated } = await tx.query(
        `UPDATE seats
            SET status = 'held',
                hold_id = $1,
                hold_expires_at = $2::timestamptz
          WHERE id IN (${updatePlaceholders})
            AND status = 'available'
          RETURNING *`,
        [holdId, expiresAtIso, ...ids]
      );

      // Defensive: if we somehow didn't flip all of them, roll back.
      if (updated.length !== ids.length) {
        const err = new Error('seat acquisition race');
        err.code = 'CONFLICT_RACE';
        throw err; // rolls back the transaction
      }

      heldUpdates = updated.map(shapeSeat);
      result = {
        ok: true,
        hold: {
          id: holdId,
          sessionId,
          seatIds: ids,
          expiresAt: expiresAtIso,
          status: 'active'
        }
      };
    });

    // Broadcast outside the transaction.
    if (releasedDuringExpiry.length) broadcastSeatUpdates(releasedDuringExpiry);
    if (result.ok) broadcastSeatUpdates(heldUpdates);

    if (!result.ok) {
      if (result.code === 'UNKNOWN_SEATS') {
        const err = new Error('Unknown seat ids: ' + result.unknown.join(', '));
        err.code = 'BAD_REQUEST';
        err.unknown = result.unknown;
        throw err;
      }
      const err = new Error('Some seats are no longer available');
      err.code = 'CONFLICT';
      err.conflicts = result.conflicts;
      throw err;
    }

    return result.hold;
  });
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

// Confirm a hold, booking its seats permanently. Idempotent: confirming an
// already-confirmed hold returns the same booking and books nothing more.
// Expired or unknown holds fail and book nothing.
export async function confirmHold(holdId) {
  const db = await getDb();

  return withLock(async () => {
    let result;
    let releasedDuringExpiry = [];
    let bookedUpdates = [];

    await db.transaction(async (tx) => {
      // Enforce expiry first. This may release the hold we're about to confirm
      // if it is past TTL, ensuring we never book an expired hold's seats.
      releasedDuringExpiry = await expireStaleHolds(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        result = { ok: false, code: 'NOT_FOUND' };
        return;
      }
      const hold = holdRows[0];

      // Idempotency: already confirmed -> return the existing booking.
      if (hold.status === 'confirmed') {
        const { rows: seats } = await tx.query(
          `SELECT * FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number`,
          [holdId]
        );
        result = {
          ok: true,
          idempotent: true,
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: seats.map((s) => s.id),
            status: 'confirmed'
          }
        };
        return;
      }

      // Released or expired -> cannot confirm, book nothing.
      if (hold.status !== 'active') {
        result = { ok: false, code: 'EXPIRED' };
        return;
      }

      // Active but already past expiry (defensive; expireStaleHolds should
      // have caught it). Treat as expired.
      if (new Date(hold.expires_at).getTime() <= Date.now()) {
        await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
        // Free its seats.
        const { rows: freed } = await tx.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING *`,
          [holdId]
        );
        releasedDuringExpiry = releasedDuringExpiry.concat(freed.map(shapeSeat));
        result = { ok: false, code: 'EXPIRED' };
        return;
      }

      // Book exactly the seats this hold still owns (status 'held' and the
      // matching hold_id). This re-validates ownership inside the txn.
      const { rows: booked } = await tx.query(
        `UPDATE seats
            SET status = 'booked',
                booked_by = $1,
                hold_expires_at = NULL
          WHERE hold_id = $2 AND status = 'held'
          RETURNING *`,
        [hold.session_id, holdId]
      );

      if (booked.length === 0) {
        // The hold owns no held seats anymore -> nothing to book.
        result = { ok: false, code: 'EXPIRED' };
        return;
      }

      await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

      bookedUpdates = booked.map(shapeSeat);
      result = {
        ok: true,
        idempotent: false,
        booking: {
          holdId,
          sessionId: hold.session_id,
          seatIds: booked.map((b) => b.id).sort(),
          status: 'confirmed'
        }
      };
    });

    if (releasedDuringExpiry.length) broadcastSeatUpdates(releasedDuringExpiry);
    if (result.ok && !result.idempotent) broadcastSeatUpdates(bookedUpdates);

    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        const err = new Error('Hold not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      const err = new Error('Hold has expired or is no longer valid');
      err.code = 'EXPIRED';
      throw err;
    }

    return result.booking;
  });
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

// Release a hold early, returning its seats to available. Idempotent: releasing
// an already-released/confirmed hold is a no-op for booked seats (confirmed
// holds are NOT un-booked).
export async function releaseHold(holdId) {
  const db = await getDb();

  return withLock(async () => {
    let releasedDuringExpiry = [];
    let freedUpdates = [];
    let status = 'released';

    await db.transaction(async (tx) => {
      releasedDuringExpiry = await expireStaleHolds(tx);

      const { rows: holdRows } = await tx.query(
        `SELECT * FROM holds WHERE id = $1`,
        [holdId]
      );
      if (holdRows.length === 0) {
        status = 'not_found';
        return;
      }
      const hold = holdRows[0];

      if (hold.status === 'confirmed') {
        // Do not un-book confirmed seats.
        status = 'confirmed';
        return;
      }

      // Mark the hold released and free any seats it still holds.
      await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
      const { rows: freed } = await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING *`,
        [holdId]
      );
      freedUpdates = freed.map(shapeSeat);
      status = 'released';
    });

    if (releasedDuringExpiry.length) broadcastSeatUpdates(releasedDuringExpiry);
    if (freedUpdates.length) broadcastSeatUpdates(freedUpdates);

    if (status === 'not_found') {
      const err = new Error('Hold not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return { holdId, status };
  });
}

// ---------------------------------------------------------------------------
// Periodic sweep
// ---------------------------------------------------------------------------

// Run the expiry pass and broadcast any releases. Called on an interval.
export async function sweepExpiredHolds() {
  const db = await getDb();
  return withLock(async () => {
    let released = [];
    await db.transaction(async (tx) => {
      released = await expireStaleHolds(tx);
    });
    if (released.length) broadcastSeatUpdates(released);
    return released.length;
  });
}

// ---------------------------------------------------------------------------
// Inventory (used for self-checks / debugging)
// ---------------------------------------------------------------------------

export async function getInventory() {
  const db = await getDb();
  return withLock(async () => {
    await db.transaction(async (tx) => {
      await expireStaleHolds(tx);
    });
    const { rows } = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM seats GROUP BY status`
    );
    const counts = { available: 0, held: 0, booked: 0 };
    for (const r of rows) counts[r.status] = r.count;
    counts.total = counts.available + counts.held + counts.booked;
    return counts;
  });
}
