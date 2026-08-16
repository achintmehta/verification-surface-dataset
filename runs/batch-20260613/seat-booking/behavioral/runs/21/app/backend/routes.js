import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { addClient, broadcast } from './sse.js';
import { releaseExpiredHolds } from './holdExpiry.js';

const HOLD_TTL_SECONDS = 30;

export function createRouter(db) {
  const router = Router();

  // ─── SSE endpoint ───────────────────────────────────────────
  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n'); // comment to establish connection
    addClient(res);
  });

  // ─── GET /api/seats ─────────────────────────────────────────
  router.get('/seats', async (_req, res) => {
    try {
      // Release expired holds first (lazy sweep on read)
      await releaseExpiredHolds(db);

      const result = await db.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
        FROM seats
        ORDER BY row_label, seat_number
      `);

      // Map effective status: expired holds appear as available
      const seats = result.rows.map(mapEffectiveStatus);
      res.json({ seats });
    } catch (err) {
      console.error('GET /api/seats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── POST /api/holds ────────────────────────────────────────
  router.post('/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      // Release expired holds first
      await releaseExpiredHolds(db);

      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      // Use a transaction with serializable isolation to prevent races
      const result = await db.transaction(async (tx) => {
        // Lock and check all requested seats
        const seatIdPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
        const checkResult = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
           FROM seats
           WHERE id IN (${seatIdPlaceholders})
           FOR UPDATE`,
          seatIds
        );

        if (checkResult.rows.length !== seatIds.length) {
          const foundIds = new Set(checkResult.rows.map(r => r.id));
          const missingIds = seatIds.filter(id => !foundIds.has(id));
          return { error: 'Some seat ids not found', missingIds, status: 400 };
        }

        // Check which seats are actually unavailable
        // (treat expired holds as available)
        const now = new Date();
        const conflicting = [];
        const expiredInTransaction = [];

        for (const seat of checkResult.rows) {
          if (seat.status === 'booked') {
            conflicting.push({ id: seat.id, row_label: seat.row_label, seat_number: seat.seat_number, status: 'booked' });
          } else if (seat.status === 'held') {
            // Check if the hold has expired
            if (seat.hold_expires_at && new Date(seat.hold_expires_at) <= now) {
              expiredInTransaction.push(seat.id);
            } else {
              conflicting.push({ id: seat.id, row_label: seat.row_label, seat_number: seat.seat_number, status: 'held' });
            }
          }
        }

        // Release any expired holds found in this transaction
        if (expiredInTransaction.length > 0) {
          const expPlaceholders = expiredInTransaction.map((_, i) => `$${i + 1}`).join(', ');
          await tx.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
             WHERE id IN (${expPlaceholders})`,
            expiredInTransaction
          );
        }

        if (conflicting.length > 0) {
          return { error: 'Some seats are unavailable', conflictingSeats: conflicting, status: 409 };
        }

        // All seats are available, acquire them
        const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(', ');
        const updatedResult = await tx.query(
          `UPDATE seats
           SET status = 'held',
               hold_id = $1,
               hold_expires_at = $2,
               session_id = $3
           WHERE id IN (${updatePlaceholders})
             AND (status = 'available' OR (status = 'held' AND hold_expires_at <= NOW()))
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id`,
          [holdId, expiresAt, sessionId, ...seatIds]
        );

        // Double-check we actually acquired them all (belt and suspenders)
        if (updatedResult.rows.length !== seatIds.length) {
          // This shouldn't happen given the checks above, but to be safe
          return { error: 'Failed to acquire all seats (concurrent modification)', status: 409 };
        }

        return {
          holdId,
          expiresAt,
          seats: updatedResult.rows,
          status: 201,
        };
      });

      if (result.error) {
        return res.status(result.status).json({
          error: result.error,
          conflictingSeats: result.conflictingSeats,
          missingIds: result.missingIds,
        });
      }

      // Broadcast updates for held seats
      for (const seat of result.seats) {
        broadcast('seat-update', {
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: 'held',
          hold_id: holdId,
          hold_expires_at: expiresAt,
          session_id: sessionId,
          booked_by: null,
        });
      }

      // Also broadcast any expired seats that were released during this transaction
      // (those were handled inside the transaction and will be reflected in the next GET)

      return res.status(201).json({
        holdId: result.holdId,
        expiresAt: result.expiresAt,
        seats: result.seats.map(s => ({ id: s.id, row_label: s.row_label, seat_number: s.seat_number })),
      });
    } catch (err) {
      console.error('POST /api/holds error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── POST /api/holds/:holdId/confirm ────────────────────────
  router.post('/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;

    try {
      const result = await db.transaction(async (tx) => {
        // First check: are there seats already booked with this hold_id?
        // This handles idempotency.
        const alreadyBooked = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, booked_by, session_id
           FROM seats
           WHERE hold_id = $1 AND status = 'booked'
           FOR UPDATE`,
          [holdId]
        );

        if (alreadyBooked.rows.length > 0) {
          // Idempotent: already confirmed
          return {
            status: 200,
            seats: alreadyBooked.rows,
            alreadyConfirmed: true,
          };
        }

        // Check for held seats with this hold_id
        const heldSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
           FROM seats
           WHERE hold_id = $1 AND status = 'held'
           FOR UPDATE`,
          [holdId]
        );

        if (heldSeats.rows.length === 0) {
          // No seats found with this hold — either it never existed or it expired
          return { error: 'Hold not found or expired', status: 404 };
        }

        // Check if the hold has expired
        const now = new Date();
        for (const seat of heldSeats.rows) {
          if (seat.hold_expires_at && new Date(seat.hold_expires_at) <= now) {
            // Hold expired — release seats
            await tx.query(
              `UPDATE seats
               SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
               WHERE hold_id = $1 AND status = 'held'`,
              [holdId]
            );
            return { error: 'Hold has expired', status: 410, expiredSeats: heldSeats.rows };
          }
        }

        // All good — book the seats
        const sessionId = heldSeats.rows[0].session_id;
        const bookedResult = await tx.query(
          `UPDATE seats
           SET status = 'booked',
               booked_by = $1,
               hold_expires_at = NULL
           WHERE hold_id = $2 AND status = 'held'
           RETURNING id, row_label, seat_number, status, hold_id, booked_by, session_id`,
          [sessionId, holdId]
        );

        return {
          status: 200,
          seats: bookedResult.rows,
          alreadyConfirmed: false,
        };
      });

      if (result.error) {
        // If it expired, broadcast the releases
        if (result.expiredSeats) {
          for (const seat of result.expiredSeats) {
            broadcast('seat-update', {
              id: seat.id,
              row_label: seat.row_label,
              seat_number: seat.seat_number,
              status: 'available',
              hold_id: null,
              hold_expires_at: null,
              session_id: null,
              booked_by: null,
            });
          }
        }
        return res.status(result.status).json({ error: result.error });
      }

      // Broadcast booked status (only on first confirmation)
      if (!result.alreadyConfirmed) {
        for (const seat of result.seats) {
          broadcast('seat-update', {
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: 'booked',
            hold_id: seat.hold_id,
            hold_expires_at: null,
            session_id: seat.session_id,
            booked_by: seat.booked_by,
          });
        }
      }

      return res.status(200).json({
        holdId,
        seats: result.seats.map(s => ({
          id: s.id,
          row_label: s.row_label,
          seat_number: s.seat_number,
          status: s.status,
        })),
      });
    } catch (err) {
      console.error('POST /api/holds/:holdId/confirm error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── DELETE /api/holds/:holdId ──────────────────────────────
  router.delete('/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;

    try {
      const result = await db.transaction(async (tx) => {
        const heldSeats = await tx.query(
          `SELECT id, row_label, seat_number
           FROM seats
           WHERE hold_id = $1 AND status = 'held'
           FOR UPDATE`,
          [holdId]
        );

        if (heldSeats.rows.length === 0) {
          // Check if they're already booked (can't release booked seats)
          const bookedSeats = await tx.query(
            `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
            [holdId]
          );
          if (bookedSeats.rows.length > 0) {
            return { error: 'Hold already confirmed, cannot release', status: 400 };
          }
          return { error: 'Hold not found or already expired', status: 404 };
        }

        const released = await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [holdId]
        );

        return { status: 200, seats: released.rows };
      });

      if (result.error) {
        return res.status(result.status).json({ error: result.error });
      }

      // Broadcast releases
      for (const seat of result.seats) {
        broadcast('seat-update', {
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
          booked_by: null,
        });
      }

      return res.status(200).json({
        holdId,
        releasedSeats: result.seats.map(s => ({ id: s.id, row_label: s.row_label, seat_number: s.seat_number })),
      });
    } catch (err) {
      console.error('DELETE /api/holds/:holdId error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/**
 * Map a seat row to its effective status:
 * A held seat with expired hold_expires_at is effectively available.
 */
function mapEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at) {
    const expiresAt = new Date(seat.hold_expires_at);
    if (expiresAt <= new Date()) {
      return {
        ...seat,
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
        session_id: null,
      };
    }
  }
  return seat;
}
