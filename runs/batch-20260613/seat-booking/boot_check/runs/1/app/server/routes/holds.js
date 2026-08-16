import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { expireStaleHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

const HOLD_TTL_SECONDS = 60; // seats held for 60 seconds

// ---------------------------------------------------------------------------
// POST /api/holds
// Body: { seatIds: string[], sessionId: string }
// Atomically acquires ALL requested seats or none (all-or-nothing).
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    // Run everything inside a transaction so the check-and-set is atomic
    const result = await db.transaction(async (tx) => {
      // 1. Expire stale holds first (within the same transaction)
      await expireStaleHolds(tx);

      // 2. Lock the requested seats with SELECT FOR UPDATE (PGLite serialises
      //    transactions, but we still use FOR UPDATE for correctness semantics)
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
        seatIds
      );

      // 3. Verify all requested seat ids actually exist
      if (seats.length !== seatIds.length) {
        const found = new Set(seats.map(s => s.id));
        const missing = seatIds.filter(id => !found.has(id));
        throw { status: 400, body: { error: 'Unknown seat ids', missing } };
      }

      // 4. Check for conflicts (any seat not available)
      const conflicts = seats.filter(s => s.status !== 'available');
      if (conflicts.length > 0) {
        throw {
          status: 409,
          body: {
            error: 'One or more seats are unavailable',
            conflictingSeatIds: conflicts.map(s => s.id),
          },
        };
      }

      // 5. Create the hold record
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // 6. Mark every seat as held
      await tx.query(
        `UPDATE seats
         SET    status = 'held',
                hold_id = $1,
                hold_expires_at = $2
         WHERE  id IN (${placeholders})`,
        [holdId, expiresAt.toISOString(), ...seatIds]
      );

      return { holdId, sessionId, seatIds, expiresAt };
    });

    // Broadcast outside the transaction
    broadcast('held', result.seatIds.map(id => ({
      id,
      status: 'held',
      holdId: result.holdId,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    })));

    // Also broadcast any freed seats from the expiry step
    // (expireStaleHolds inside the tx already ran; we broadcast after commit)
    // The freed seats are handled by the next GET /api/seats or sweep.

    return res.status(201).json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seatIds: result.seatIds,
      expiresAt: result.expiresAt,
      ttlSeconds: HOLD_TTL_SECONDS,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// Idempotent: confirming an already-confirmed hold returns the same booking.
// ---------------------------------------------------------------------------
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // 1. Fetch the hold (lock it)
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      // 2. Idempotent: already confirmed → return existing booking
      if (holdRows.length > 0 && holdRows[0].confirmed) {
        const { rows: bookedSeats } = await tx.query(
          `SELECT id, status, booked_by FROM seats WHERE hold_id = $1`,
          [holdId]
        );
        return { alreadyConfirmed: true, holdId, sessionId, seats: bookedSeats };
      }

      // 3. Hold must exist
      if (holdRows.length === 0) {
        throw { status: 404, body: { error: 'Hold not found or already expired' } };
      }

      const hold = holdRows[0];

      // 4. Ownership check
      if (hold.session_id !== sessionId) {
        throw { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      // 5. Expiry check
      if (new Date(hold.expires_at) <= new Date()) {
        throw { status: 410, body: { error: 'Hold has expired' } };
      }

      // 6. Verify seats still belong to this hold and are still held
      const { rows: heldSeats } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        throw { status: 409, body: { error: 'No held seats found for this hold' } };
      }

      const seatIds = heldSeats.map(s => s.id);
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');

      // 7. Book the seats
      await tx.query(
        `UPDATE seats
         SET    status = 'booked',
                booked_by = $${seatIds.length + 1},
                hold_expires_at = NULL
         WHERE  id IN (${placeholders})`,
        [...seatIds, sessionId]
      );

      // 8. Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return { alreadyConfirmed: false, holdId, sessionId, seatIds };
    });

    if (result.alreadyConfirmed) {
      broadcast('booked', result.seats.map(s => ({
        id: s.id,
        status: 'booked',
        holdId: result.holdId,
        sessionId: result.sessionId,
      })));
      return res.status(200).json({
        message: 'Already confirmed',
        holdId: result.holdId,
        seatIds: result.seats.map(s => s.id),
      });
    }

    broadcast('booked', result.seatIds.map(id => ({
      id,
      status: 'booked',
      holdId: result.holdId,
      sessionId: result.sessionId,
    })));

    return res.status(200).json({
      message: 'Booking confirmed',
      holdId: result.holdId,
      seatIds: result.seatIds,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error('[POST /api/holds/:holdId/confirm]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// Release a hold early, returning its seats to available.
// ---------------------------------------------------------------------------
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const { rows: holdRows } = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        throw { status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      if (hold.confirmed) {
        throw { status: 409, body: { error: 'Cannot release a confirmed hold' } };
      }

      // Release the seats
      const { rows: releasedSeats } = await tx.query(
        `UPDATE seats
         SET    status = 'available',
                hold_id = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
         RETURNING id`,
        [holdId]
      );

      // Delete the hold
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return { seatIds: releasedSeats.map(s => s.id) };
    });

    broadcast('released', result.seatIds.map(id => ({ id, status: 'available' })));

    return res.status(200).json({
      message: 'Hold released',
      holdId,
      seatIds: result.seatIds,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error('[DELETE /api/holds/:holdId]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
