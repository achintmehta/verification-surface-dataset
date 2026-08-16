import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { addClient, broadcast } from './sse.js';
import { expireStaleHolds } from './expiry.js';

const HOLD_TTL_SECONDS = 30; // 30 second holds

export function createRoutes(db) {
  const router = Router();
  // ─── SSE stream ────────────────────────────────────────────
  router.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':ok\n\n');
    addClient(res);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 15000);

    req.on('close', () => clearInterval(heartbeat));
  });

  // ─── GET /api/seats ────────────────────────────────────────
  router.get('/api/seats', async (req, res) => {
    try {
      // Expire stale holds first (lazy enforcement)
      await expireStaleHolds(db);

      const result = await db.query(`
        SELECT id, row_label, seat_number, status, hold_id,
               hold_expires_at, booked_by, session_id
        FROM seats
        ORDER BY row_label, seat_number
      `);

      // Map effective status: held seats past TTL → available
      const seats = result.rows.map(seat => {
        if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) {
          return {
            ...seat,
            status: 'available',
            hold_id: null,
            hold_expires_at: null,
            session_id: null
          };
        }
        return seat;
      });

      res.json({ seats });
    } catch (err) {
      console.error('GET /api/seats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── POST /api/holds ───────────────────────────────────────
  router.post('/api/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      // Expire stale holds first
      await expireStaleHolds(db);

      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      // Use a transaction with serializable isolation for atomicity
      // We'll do it step by step within a transaction block
      await db.query('BEGIN');

      try {
        // Check all requested seats are available
        // Build parameterized query for the seat ids
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
        const checkResult = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
           FROM seats
           WHERE id IN (${placeholders})
           FOR UPDATE`,
          seatIds
        );

        if (checkResult.rows.length !== seatIds.length) {
          await db.query('ROLLBACK');
          return res.status(400).json({ error: 'Some seat ids are invalid' });
        }

        // Determine effective status considering expiry for each seat
        const unavailable = [];
        const toExpire = [];
        for (const seat of checkResult.rows) {
          let effectiveStatus = seat.status;
          if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) {
            effectiveStatus = 'available';
            toExpire.push(seat.id);
          }
          if (effectiveStatus !== 'available') {
            unavailable.push({
              id: seat.id,
              row_label: seat.row_label,
              seat_number: seat.seat_number,
              status: effectiveStatus
            });
          }
        }

        // If there are expired seats among requested, release them first
        if (toExpire.length > 0) {
          const expPlaceholders = toExpire.map((_, i) => `$${i + 1}`).join(', ');
          await db.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE id IN (${expPlaceholders})`,
            toExpire
          );
          // Also mark their holds as expired
          await db.query(
            `UPDATE holds SET status = 'expired'
             WHERE status = 'active' AND expires_at < NOW()`
          );
        }

        // If any seats are unavailable (not expired-and-releasable), reject all
        if (unavailable.length > 0) {
          await db.query('ROLLBACK');
          return res.status(409).json({
            error: 'Some seats are unavailable',
            conflicting: unavailable
          });
        }

        // All seats are available - acquire them all atomically
        const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(', ');
        await db.query(
          `UPDATE seats
           SET status = 'held',
               hold_id = $1,
               hold_expires_at = $2::timestamptz,
               session_id = $3
           WHERE id IN (${updatePlaceholders})`,
          [holdId, expiresAt, sessionId, ...seatIds]
        );

        // Insert hold record
        await db.query(
          `INSERT INTO holds (id, session_id, seat_ids, expires_at)
           VALUES ($1, $2, $3, $4::timestamptz)`,
          [holdId, sessionId, seatIds, expiresAt]
        );

        await db.query('COMMIT');

        // Fetch updated seats for response and broadcast
        const updatedResult = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats WHERE id IN (${placeholders})`,
          seatIds
        );

        // Broadcast seat updates
        for (const seat of updatedResult.rows) {
          broadcast('seat-update', seat);
        }

        // Broadcast expired seats that were released as part of this operation
        if (toExpire.length > 0) {
          for (const seatId of toExpire) {
            // These are in our requested seats, so they got held again - no separate broadcast needed
          }
        }

        res.status(201).json({
          hold: {
            id: holdId,
            sessionId,
            seatIds,
            expiresAt
          },
          seats: updatedResult.rows
        });

      } catch (innerErr) {
        await db.query('ROLLBACK');
        throw innerErr;
      }

    } catch (err) {
      console.error('POST /api/holds error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ─── POST /api/holds/:holdId/confirm ──────────────────────
  router.post('/api/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;

    try {
      await db.query('BEGIN');

      try {
        // Fetch the hold with FOR UPDATE lock
        const holdResult = await db.query(
          `SELECT id, session_id, seat_ids, expires_at, status
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          await db.query('ROLLBACK');
          return res.status(404).json({ error: 'Hold not found' });
        }

        const hold = holdResult.rows[0];

        // Idempotent: if already confirmed, return success
        if (hold.status === 'confirmed') {
          await db.query('ROLLBACK');

          const seatsResult = await db.query(
            `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
             FROM seats WHERE booked_by = $1`,
            [holdId]
          );

          return res.json({
            message: 'Already confirmed',
            hold: {
              id: hold.id,
              sessionId: hold.session_id,
              seatIds: hold.seat_ids,
              status: 'confirmed'
            },
            seats: seatsResult.rows
          });
        }

        // Check if expired
        if (hold.status === 'expired' || new Date(hold.expires_at) < new Date()) {
          // Mark as expired if not already
          await db.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
            [holdId]
          );
          // Release the seats if still held by this hold
          const releasedResult = await db.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE hold_id = $1 AND status = 'held'
             RETURNING id, row_label, seat_number`,
            [holdId]
          );

          await db.query('COMMIT');

          // Broadcast released seats
          for (const seat of releasedResult.rows) {
            broadcast('seat-update', {
              id: seat.id,
              row_label: seat.row_label,
              seat_number: seat.seat_number,
              status: 'available',
              hold_id: null,
              hold_expires_at: null,
              session_id: null,
              booked_by: null
            });
          }

          return res.status(410).json({ error: 'Hold has expired' });
        }

        // Check hold is active
        if (hold.status === 'released') {
          await db.query('ROLLBACK');
          return res.status(410).json({ error: 'Hold was released' });
        }

        // Verify seats are still held by this hold
        const seatIds = hold.seat_ids;
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
        const seatsResult = await db.query(
          `SELECT id, status, hold_id
           FROM seats
           WHERE id IN (${placeholders})
           FOR UPDATE`,
          seatIds
        );

        // Verify all seats are held by this holdId
        const allOwnedAndHeld = seatsResult.rows.every(
          s => s.status === 'held' && s.hold_id === holdId
        );

        if (!allOwnedAndHeld) {
          // Something went wrong - seats were released or taken
          await db.query(
            `UPDATE holds SET status = 'expired' WHERE id = $1`,
            [holdId]
          );
          await db.query('COMMIT');
          return res.status(409).json({ error: 'Hold seats are no longer valid' });
        }

        // Book the seats
        await db.query(
          `UPDATE seats
           SET status = 'booked',
               booked_by = $1
           WHERE hold_id = $2 AND status = 'held'`,
          [holdId, holdId]
        );

        // Mark hold as confirmed
        await db.query(
          `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
          [holdId]
        );

        await db.query('COMMIT');

        // Fetch updated seats
        const updatedSeats = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats WHERE id IN (${placeholders})`,
          seatIds
        );

        // Broadcast seat updates
        for (const seat of updatedSeats.rows) {
          broadcast('seat-update', seat);
        }

        res.json({
          message: 'Booking confirmed',
          hold: {
            id: hold.id,
            sessionId: hold.session_id,
            seatIds: hold.seat_ids,
            status: 'confirmed'
          },
          seats: updatedSeats.rows
        });

      } catch (innerErr) {
        await db.query('ROLLBACK');
        throw innerErr;
      }

    } catch (err) {
      console.error('POST /api/holds/:holdId/confirm error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ─── DELETE /api/holds/:holdId ─────────────────────────────
  router.delete('/api/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;

    try {
      await db.query('BEGIN');

      try {
        // Fetch hold
        const holdResult = await db.query(
          `SELECT id, session_id, seat_ids, status
           FROM holds
           WHERE id = $1
           FOR UPDATE`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          await db.query('ROLLBACK');
          return res.status(404).json({ error: 'Hold not found' });
        }

        const hold = holdResult.rows[0];

        if (hold.status === 'confirmed') {
          await db.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot release a confirmed hold' });
        }

        if (hold.status === 'released' || hold.status === 'expired') {
          await db.query('ROLLBACK');
          return res.json({ message: 'Hold already released' });
        }

        // Release seats
        const releasedResult = await db.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [holdId]
        );

        // Mark hold as released
        await db.query(
          `UPDATE holds SET status = 'released' WHERE id = $1`,
          [holdId]
        );

        await db.query('COMMIT');

        // Broadcast released seats
        for (const seat of releasedResult.rows) {
          broadcast('seat-update', {
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: 'available',
            hold_id: null,
            hold_expires_at: null,
            session_id: null,
            booked_by: null
          });
        }

        res.json({ message: 'Hold released', releasedSeats: releasedResult.rows });

      } catch (innerErr) {
        await db.query('ROLLBACK');
        throw innerErr;
      }

    } catch (err) {
      console.error('DELETE /api/holds/:holdId error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ─── GET /api/inventory ────────────────────────────────────
  router.get('/api/inventory', async (req, res) => {
    try {
      await expireStaleHolds(db);

      const result = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'available')::int AS available,
          COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > NOW())::int AS held,
          COUNT(*) FILTER (WHERE status = 'booked')::int AS booked,
          COUNT(*)::int AS total
        FROM seats
      `);

      res.json(result.rows[0]);
    } catch (err) {
      console.error('GET /api/inventory error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
