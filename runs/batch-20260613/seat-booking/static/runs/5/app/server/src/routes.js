/**
 * All HTTP + SSE route handlers.
 *
 * Endpoints
 * ─────────
 *  GET  /api/seats                  – full seat map with effective status
 *  POST /api/holds                  – atomic all-or-nothing hold acquisition
 *  POST /api/holds/:holdId/confirm  – idempotent hold confirmation → booking
 *  DELETE /api/holds/:holdId        – early hold release
 *  GET  /api/stream                 – SSE event stream
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { getDb, withTx, HOLD_TTL_SECONDS } from './db.js';
import { releaseExpiredHolds } from './expiry.js';
import { addClient, removeClient, broadcast } from './sse.js';

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

/** Map a DB row to the public seat DTO. */
function seatDto(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id ?? null,
    holdExpiresAt: row.hold_expires_at ?? null,
    bookedBy: row.booked_by ?? null,
  };
}

/**
 * Build a parameterised SQL IN-list.
 *
 * inList(['a','b'], 1) → { clause: '($1,$2)', values: ['a','b'] }
 *
 * @param {string[]} ids
 * @param {number}   startIndex  1-based index of the first placeholder
 */
function inList(ids, startIndex = 1) {
  const clause = '(' + ids.map((_, i) => `$${startIndex + i}`).join(',') + ')';
  return { clause, values: ids };
}

// ── GET /api/seats ─────────────────────────────────────────────────────────
/**
 * Return every seat with its current effective status.
 * Expired holds are swept lazily here so the response is always accurate.
 */
router.get('/seats', async (_req, res) => {
  try {
    const released = await withTx((db) => releaseExpiredHolds(db));
    if (released.length > 0) {
      broadcast('seats:released', {
        seats: released.map((s) => ({
          id: s.id,
          rowLabel: s.row_label,
          seatNumber: s.seat_number,
          status: 'available',
        })),
      });
    }

    const db = getDb();
    const { rows } = await db.query(
      'SELECT * FROM seats ORDER BY row_label, seat_number'
    );
    res.json({ seats: rows.map(seatDto) });
  } catch (err) {
    console.error('[GET /seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/holds ────────────────────────────────────────────────────────
/**
 * Atomically acquire ALL requested seats (all-or-nothing).
 *
 * Algorithm (single transaction):
 *  1. Sweep expired holds.
 *  2. SELECT … FOR UPDATE on the requested seats (row-level lock).
 *  3. Verify every seat is `available`; if not → ROLLBACK + 409.
 *  4. INSERT hold record.
 *  5. UPDATE seats to `held`.
 *  6. COMMIT, then broadcast.
 */
router.post('/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  if (
    !Array.isArray(seatIds) ||
    seatIds.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.trim() === ''
  ) {
    return res
      .status(400)
      .json({ error: 'seatIds (non-empty array) and sessionId (string) are required' });
  }

  const uniqueSeatIds = [...new Set(seatIds)];
  const trimmedSession = sessionId.trim();

  try {
    const result = await withTx(async (db) => {
      // 1. Sweep expired holds first.
      const released = await releaseExpiredHolds(db);

      // 2. Lock the requested seat rows.
      const { clause: lockClause, values: lockValues } = inList(uniqueSeatIds);
      const { rows: lockedSeats } = await db.query(
        `SELECT id, status FROM seats WHERE id IN ${lockClause} FOR UPDATE`,
        lockValues
      );

      // Verify all requested seats exist.
      if (lockedSeats.length !== uniqueSeatIds.length) {
        const foundIds = new Set(lockedSeats.map((s) => s.id));
        const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
        const err = new Error('Some seat ids do not exist');
        err.status = 400;
        err.detail = { missingSeats: missing };
        throw err;
      }

      // 3. Check availability.
      const unavailable = lockedSeats.filter((s) => s.status !== 'available');
      if (unavailable.length > 0) {
        const err = new Error('One or more seats are unavailable');
        err.status = 409;
        err.detail = { conflictingSeats: unavailable.map((s) => s.id) };
        throw err;
      }

      // 4. Create the hold record.
      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
      await db.query(
        `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
        [holdId, trimmedSession, expiresAt]
      );

      // 5. Mark seats as held.
      //    $1 = holdId, $2 = expiresAt, $3…$N = seat ids
      const { clause: updateClause, values: updateValues } = inList(uniqueSeatIds, 3);
      await db.query(
        `UPDATE seats
         SET status          = 'held',
             hold_id         = $1,
             hold_expires_at = $2
         WHERE id IN ${updateClause}`,
        [holdId, expiresAt, ...updateValues]
      );

      // Fetch updated seat rows to return & broadcast.
      const { clause: fetchClause, values: fetchValues } = inList(uniqueSeatIds);
      const { rows: updatedSeats } = await db.query(
        `SELECT * FROM seats WHERE id IN ${fetchClause}`,
        fetchValues
      );

      return { holdId, expiresAt, sessionId: trimmedSession, updatedSeats, released };
    });

    // Broadcast released seats from the expiry sweep.
    if (result.released.length > 0) {
      broadcast('seats:released', {
        seats: result.released.map((s) => ({
          id: s.id,
          rowLabel: s.row_label,
          seatNumber: s.seat_number,
          status: 'available',
        })),
      });
    }

    // Broadcast the new holds.
    broadcast('seats:held', {
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seats: result.updatedSeats.map(seatDto),
    });

    res.status(201).json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
      seats: result.updatedSeats.map(seatDto),
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, ...err.detail });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message, ...err.detail });
    }
    console.error('[POST /holds]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/holds/:holdId/confirm ────────────────────────────────────────
/**
 * Confirm a hold → permanently book its seats.
 *
 * Idempotency: a second confirm of the same hold returns the same booking
 * data without touching any seat rows.
 *
 * Failure modes:
 *  - Hold not found → 404
 *  - sessionId mismatch → 403
 *  - Hold expired (not yet confirmed) → 410
 */
router.post('/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const trimmedSession = sessionId.trim();

  try {
    const result = await withTx(async (db) => {
      // Sweep other expired holds (but not the one we're about to confirm).
      await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id IN (
           SELECT id FROM holds
           WHERE expires_at <= now() AND confirmed = FALSE AND id != $1
         ) AND status = 'held'`,
        [holdId]
      );
      await db.query(
        `DELETE FROM holds WHERE expires_at <= now() AND confirmed = FALSE AND id != $1`,
        [holdId]
      );

      // Lock the hold row.
      const { rows: holdRows } = await db.query(
        `SELECT * FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        const err = new Error('Hold not found');
        err.status = 404;
        throw err;
      }

      const hold = holdRows[0];

      // Session ownership check.
      if (hold.session_id !== trimmedSession) {
        const err = new Error('Forbidden: sessionId does not match hold owner');
        err.status = 403;
        throw err;
      }

      // ── Idempotency: already confirmed ──────────────────────────────────
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(
          `SELECT * FROM seats WHERE hold_id = $1`,
          [holdId]
        );
        return { alreadyConfirmed: true, holdId, sessionId: hold.session_id, seats: bookedSeats };
      }

      // ── Expiry check ────────────────────────────────────────────────────
      const now = new Date();
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= now) {
        const err = new Error('Hold has expired');
        err.status = 410;
        throw err;
      }

      // ── Lock the seat rows that belong to this hold ─────────────────────
      const { rows: heldSeats } = await db.query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        const err = new Error('No held seats found for this hold');
        err.status = 409;
        throw err;
      }

      // ── Book the seats ──────────────────────────────────────────────────
      const seatIds = heldSeats.map((s) => s.id);
      const { clause: updateClause, values: updateValues } = inList(seatIds, 2);
      await db.query(
        `UPDATE seats
         SET status    = 'booked',
             booked_by = $1
         WHERE id IN ${updateClause}`,
        [trimmedSession, ...updateValues]
      );

      // Mark hold as confirmed.
      await db.query(`UPDATE holds SET confirmed = TRUE WHERE id = $1`, [holdId]);

      // Fetch the freshly-booked seat rows.
      const { clause: fetchClause, values: fetchValues } = inList(seatIds);
      const { rows: bookedSeats } = await db.query(
        `SELECT * FROM seats WHERE id IN ${fetchClause}`,
        fetchValues
      );

      return { alreadyConfirmed: false, holdId, sessionId: hold.session_id, seats: bookedSeats };
    });

    // Broadcast booking (idempotent re-broadcast is harmless).
    broadcast('seats:booked', {
      holdId: result.holdId,
      seats: result.seats.map(seatDto),
    });

    res.json({
      holdId: result.holdId,
      sessionId: result.sessionId,
      seats: result.seats.map(seatDto),
      alreadyConfirmed: result.alreadyConfirmed,
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 410) return res.status(410).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error('[POST /holds/:holdId/confirm]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/holds/:holdId ──────────────────────────────────────────────
/**
 * Release a hold early.  Seats return to `available`.
 */
router.delete('/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const trimmedSession = sessionId.trim();

  try {
    const result = await withTx(async (db) => {
      const { rows: holdRows } = await db.query(
        `SELECT * FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRows.length === 0) {
        const err = new Error('Hold not found');
        err.status = 404;
        throw err;
      }

      const hold = holdRows[0];

      if (hold.session_id !== trimmedSession) {
        const err = new Error('Forbidden: sessionId does not match hold owner');
        err.status = 403;
        throw err;
      }

      if (hold.confirmed) {
        const err = new Error('Cannot release a confirmed hold');
        err.status = 409;
        throw err;
      }

      // Release seats.
      const { rows: releasedSeats } = await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number`,
        [holdId]
      );

      await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return { releasedSeats };
    });

    broadcast('seats:released', {
      seats: result.releasedSeats.map((s) => ({
        id: s.id,
        rowLabel: s.row_label,
        seatNumber: s.seat_number,
        status: 'available',
      })),
    });

    res.json({ released: true, seats: result.releasedSeats.map((s) => s.id) });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error('[DELETE /holds/:holdId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/stream ────────────────────────────────────────────────────────
/**
 * SSE endpoint.  Keeps the connection open and pushes seat-status events.
 */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial heartbeat so the client knows the connection is live.
  res.write('event: connected\ndata: {}\n\n');

  addClient(res);

  // Heartbeat every 20 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
