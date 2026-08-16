/**
 * routes/holds.js
 *
 * POST   /api/holds                  – create a hold (all-or-nothing)
 * POST   /api/holds/:holdId/confirm  – confirm a hold (idempotent)
 * DELETE /api/holds/:holdId          – release a hold early
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

// ── POST /api/holds ──────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (
    !Array.isArray(seatIds) ||
    seatIds.length === 0 ||
    seatIds.some((id) => typeof id !== 'string')
  ) {
    return res.status(400).json({ error: '`seatIds` must be a non-empty array of strings.' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: '`sessionId` must be a non-empty string.' });
  }

  const db = await getDb();

  try {
    // ── Step 1: release expired holds (outside the main transaction so the
    //   freed seats are visible to the SELECT FOR UPDATE below). ─────────────
    const freed = await releaseExpiredHolds(db);
    if (freed.length > 0) {
      broadcast('seat-update', { type: 'released', seatIds: freed, status: 'available' });
    }

    // ── Step 2: atomic acquisition inside a serialisable transaction ─────────
    //
    // We use an explicit transaction with SELECT … FOR UPDATE to lock the
    // requested seat rows.  If any seat is not `available` we roll back and
    // return 409 with the conflicting ids.  This guarantees that two
    // concurrent requests for the same seat cannot both succeed.

    let holdId;
    let expiresAt;
    let acquiredSeats;

    await db.transaction(async (tx) => {
      // Lock the requested rows.
      // Placeholders for seat ids start at $1 (used in the SELECT).
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: lockedSeats } = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${seatPlaceholders}) FOR UPDATE`,
        seatIds
      );

      // Verify all requested seats exist.
      if (lockedSeats.length !== seatIds.length) {
        const foundIds = new Set(lockedSeats.map((r) => r.id));
        const missing = seatIds.filter((id) => !foundIds.has(id));
        const err = new Error('Some seat ids do not exist.');
        err.status = 404;
        err.detail = { missingIds: missing };
        throw err;
      }

      // Check availability.
      const unavailable = lockedSeats.filter((r) => r.status !== 'available');
      if (unavailable.length > 0) {
        const err = new Error('One or more seats are not available.');
        err.status = 409;
        err.detail = { conflictingIds: unavailable.map((r) => r.id) };
        throw err;
      }

      // Create the hold record.
      holdId = randomUUID();
      const { rows: holdRows } = await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)
         RETURNING id, session_id, expires_at`,
        [holdId, sessionId, String(HOLD_TTL_SECONDS)]
      );
      expiresAt = holdRows[0].expires_at;
      // PGLite returns timestamps as Date objects; convert to ISO string for
      // use as a query parameter.
      const expiresAtStr = expiresAt instanceof Date
        ? expiresAt.toISOString()
        : String(expiresAt);

      // Mark the seats as held.
      // $1 = holdId, $2 = expiresAt, $3...$N = seatIds
      const updateSeatPlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(', ');
      await tx.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = $2::TIMESTAMPTZ
         WHERE  id IN (${updateSeatPlaceholders})`,
        [holdId, expiresAtStr, ...seatIds]
      );

      acquiredSeats = seatIds;
    });

    // ── Step 3: broadcast the new holds ──────────────────────────────────────
    const expiresAtIso = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt);
    broadcast('seat-update', {
      type: 'held',
      seatIds: acquiredSeats,
      holdId,
      expiresAt: expiresAtIso,
      sessionId,
      status: 'held',
    });

    return res.status(201).json({
      holdId,
      sessionId,
      seatIds: acquiredSeats,
      expiresAt: expiresAtIso,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, ...err.detail });
    }
    if (err.status === 404) {
      return res.status(404).json({ error: err.message, ...err.detail });
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Failed to create hold.' });
  }
});

// ── POST /api/holds/:holdId/confirm ──────────────────────────────────────────

router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: '`sessionId` must be a non-empty string.' });
  }

  const db = await getDb();

  try {
    // Release expired holds first (so we don't accidentally confirm an expired hold).
    const freed = await releaseExpiredHolds(db);
    if (freed.length > 0) {
      broadcast('seat-update', { type: 'released', seatIds: freed, status: 'available' });
    }

    let bookedSeatIds;
    let alreadyConfirmed = false;

    await db.transaction(async (tx) => {
      // Lock the hold row.
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        const err = new Error('Hold not found or already expired.');
        err.status = 404;
        throw err;
      }

      const hold = holdRows[0];

      // Ownership check.
      if (hold.session_id !== sessionId) {
        const err = new Error('This hold belongs to a different session.');
        err.status = 403;
        throw err;
      }

      // Expiry check (belt-and-suspenders; releaseExpiredHolds above should
      // have already removed it, but we guard here too).
      if (new Date(hold.expires_at) < new Date()) {
        const err = new Error('Hold has expired.');
        err.status = 410;
        throw err;
      }

      // ── Idempotency: already confirmed ───────────────────────────────────
      if (hold.confirmed) {
        // Return the already-booked seats without doing anything.
        const { rows: seats } = await tx.query(
          `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
          [holdId]
        );
        bookedSeatIds = seats.map((r) => r.id);
        alreadyConfirmed = true;
        return; // exit transaction callback – no writes needed
      }

      // ── Lock the seats owned by this hold ────────────────────────────────
      const { rows: seatRows } = await tx.query(
        `SELECT id, status, hold_id FROM seats WHERE hold_id = $1 FOR UPDATE`,
        [holdId]
      );

      // Verify the seats are still held by this hold (race-condition guard).
      const wrongSeats = seatRows.filter(
        (s) => s.status !== 'held' || s.hold_id !== holdId
      );
      if (wrongSeats.length > 0) {
        const err = new Error('Seat state mismatch; hold may have been superseded.');
        err.status = 409;
        throw err;
      }

      bookedSeatIds = seatRows.map((r) => r.id);

      // Book the seats.
      await tx.query(
        `UPDATE seats
         SET    status   = 'booked',
                booked_by = $1,
                hold_id  = $2,
                hold_expires_at = NULL
         WHERE  hold_id = $2`,
        [sessionId, holdId]
      );

      // Mark the hold as confirmed.
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );
    });

    // Broadcast only on first confirmation.
    if (!alreadyConfirmed) {
      broadcast('seat-update', {
        type: 'booked',
        seatIds: bookedSeatIds,
        holdId,
        sessionId,
        status: 'booked',
      });
    }

    return res.json({
      holdId,
      sessionId,
      seatIds: bookedSeatIds,
      status: 'booked',
      alreadyConfirmed,
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 410) return res.status(410).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Failed to confirm hold.' });
  }
});

// ── DELETE /api/holds/:holdId ────────────────────────────────────────────────

router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: '`sessionId` must be a non-empty string.' });
  }

  const db = await getDb();

  try {
    let releasedSeatIds = [];

    await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        // Already expired / released – treat as success (idempotent).
        return;
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        const err = new Error('This hold belongs to a different session.');
        err.status = 403;
        throw err;
      }

      if (hold.confirmed) {
        const err = new Error('Cannot release a confirmed (booked) hold.');
        err.status = 409;
        throw err;
      }

      // Release the seats.
      const { rows: seatRows } = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
         RETURNING id`,
        [holdId]
      );
      releasedSeatIds = seatRows.map((r) => r.id);

      // Delete the hold record.
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);
    });

    if (releasedSeatIds.length > 0) {
      broadcast('seat-update', {
        type: 'released',
        seatIds: releasedSeatIds,
        holdId,
        status: 'available',
      });
    }

    return res.json({ holdId, releasedSeatIds });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Failed to release hold.' });
  }
});

export default router;
