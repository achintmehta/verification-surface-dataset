import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { expireStaleHolds } from './expiry.js';

const router = Router();

// Hold TTL in seconds
const HOLD_TTL_SECONDS = 60;

// Helper: parse seat_ids_json from the holds table
function parseSeatIds(hold) {
  if (!hold) return [];
  try {
    return JSON.parse(hold.seat_ids_json);
  } catch {
    return [];
  }
}

// ─── SSE Stream ──────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // Send an initial comment to flush headers
  res.write(':ok\n\n');
  addClient(res);
});

// ─── GET /seats — return all seats with effective status ─────────
router.get('/seats', async (req, res) => {
  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status,
             hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Belt-and-suspenders: report expired holds as available
    const now = new Date();
    const seats = result.rows.map(s => {
      if (s.status === 'held' && s.hold_expires_at && new Date(s.hold_expires_at) <= now) {
        return {
          ...s,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null
        };
      }
      return s;
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds — atomically acquire seats ──────────────────────
router.post('/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Ensure all seatIds are integers
  const parsedSeatIds = seatIds.map(id => parseInt(id, 10));
  if (parsedSeatIds.some(id => isNaN(id))) {
    return res.status(400).json({ error: 'All seatIds must be valid integers' });
  }

  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();
    const holdId = uuidv4();

    const result = await db.transaction(async (tx) => {
      const seatPlaceholders = parsedSeatIds.map((_, i) => `$${i + 1}`).join(', ');

      // Lock and check all requested seats
      const checkResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${seatPlaceholders})
         FOR UPDATE`,
        parsedSeatIds
      );

      if (checkResult.rows.length !== parsedSeatIds.length) {
        const foundIds = new Set(checkResult.rows.map(r => r.id));
        const missingIds = parsedSeatIds.filter(id => !foundIds.has(id));
        return { error: 'Some seat IDs do not exist', missingIds, status: 400 };
      }

      // Release any expired holds on these seats within the transaction
      await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${seatPlaceholders})
           AND status = 'held'
           AND hold_expires_at IS NOT NULL
           AND hold_expires_at <= NOW()`,
        parsedSeatIds
      );

      // Mark expired hold records
      await tx.query(`
        UPDATE holds SET status = 'expired'
        WHERE status = 'active' AND expires_at <= NOW()
      `);

      // Re-read to get accurate status after expiry
      const freshResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${seatPlaceholders})`,
        parsedSeatIds
      );

      // Check for conflicts
      const conflicting = [];
      for (const seat of freshResult.rows) {
        if (seat.status !== 'available') {
          conflicting.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: seat.status
          });
        }
      }

      if (conflicting.length > 0) {
        return { error: 'Some seats are not available', conflicting, status: 409 };
      }

      // Acquire all seats
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      const updateResult = await tx.query(
        `UPDATE seats
         SET status = 'held',
             hold_id = $${parsedSeatIds.length + 1},
             hold_expires_at = $${parsedSeatIds.length + 2},
             session_id = $${parsedSeatIds.length + 3}
         WHERE id IN (${seatPlaceholders})
           AND status = 'available'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, session_id`,
        [...parsedSeatIds, holdId, expiresAt.toISOString(), sessionId]
      );

      // Verify all seats were acquired
      if (updateResult.rows.length !== parsedSeatIds.length) {
        throw new Error('Failed to acquire all seats atomically');
      }

      // Insert hold record (store seat IDs as JSON text)
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids_json, status, expires_at)
         VALUES ($1, $2, $3, 'active', $4)`,
        [holdId, sessionId, JSON.stringify(parsedSeatIds), expiresAt.toISOString()]
      );

      return {
        hold: {
          id: holdId,
          sessionId,
          seatIds: parsedSeatIds,
          expiresAt: expiresAt.toISOString(),
          status: 'active'
        },
        updatedSeats: updateResult.rows,
        status: 201
      };
    });

    if (result.error) {
      return res.status(result.status).json({
        error: result.error,
        conflicting: result.conflicting,
        missingIds: result.missingIds
      });
    }

    // Broadcast seat updates
    for (const seat of result.updatedSeats) {
      broadcast('seat-update', {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: 'held',
        hold_id: seat.hold_id,
        hold_expires_at: seat.hold_expires_at,
        session_id: seat.session_id,
        booked_by: null
      });
    }

    res.status(201).json({ hold: result.hold });
  } catch (err) {
    console.error('POST /holds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /holds/:holdId/confirm — book the held seats ───────────
router.post('/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    // Expire stale holds first
    await expireStaleHolds();

    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Get the hold record
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids_json, status, expires_at, confirmed_at
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: 'Hold not found', status: 404 };
      }

      const hold = holdResult.rows[0];
      const seatIds = parseSeatIds(hold);

      // Idempotent: if already confirmed, return the same booking
      if (hold.status === 'confirmed') {
        const seatsResult = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, session_id, booked_by
           FROM seats
           WHERE booked_by = $1 AND hold_id = $2`,
          [hold.session_id, hold.id]
        );
        return {
          booking: {
            holdId: hold.id,
            sessionId: hold.session_id,
            seatIds,
            status: 'confirmed',
            confirmedAt: hold.confirmed_at
          },
          seats: seatsResult.rows,
          status: 200,
          alreadyConfirmed: true
        };
      }

      // Check if hold is expired or released
      if (hold.status === 'expired' || hold.status === 'released') {
        return { error: `Hold has been ${hold.status}`, status: 410 };
      }

      // Check if hold is past expiry
      if (new Date(hold.expires_at) <= new Date()) {
        // Mark hold as expired
        await tx.query(
          `UPDATE holds SET status = 'expired' WHERE id = $1`,
          [holdId]
        );
        // Release the seats
        const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
        const releasedSeats = await tx.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
           WHERE id IN (${seatPlaceholders})
             AND hold_id = $${seatIds.length + 1}
             AND status = 'held'
           RETURNING id, row_label, seat_number`,
          [...seatIds, holdId]
        );
        return {
          error: 'Hold has expired',
          status: 410,
          expiredSeats: releasedSeats.rows
        };
      }

      // Verify seats are still held by this hold
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const seatsCheck = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
         WHERE id IN (${seatPlaceholders})
         FOR UPDATE`,
        seatIds
      );

      // All seats must be held by this hold
      for (const seat of seatsCheck.rows) {
        if (seat.status !== 'held' || seat.hold_id !== holdId) {
          return {
            error: 'Hold is no longer valid — some seats have been released or reassigned',
            status: 409
          };
        }
      }

      // Book the seats
      const confirmedAt = new Date().toISOString();
      const updateSeats = await tx.query(
        `UPDATE seats
         SET status = 'booked',
             booked_by = $${seatIds.length + 1},
             hold_expires_at = NULL
         WHERE id IN (${seatPlaceholders})
           AND status = 'held'
           AND hold_id = $${seatIds.length + 2}
         RETURNING id, row_label, seat_number, status, hold_id, session_id, booked_by`,
        [...seatIds, hold.session_id, holdId]
      );

      if (updateSeats.rows.length !== seatIds.length) {
        throw new Error('Failed to book all seats');
      }

      // Update hold status
      await tx.query(
        `UPDATE holds SET status = 'confirmed', confirmed_at = $2 WHERE id = $1`,
        [holdId, confirmedAt]
      );

      return {
        booking: {
          holdId: hold.id,
          sessionId: hold.session_id,
          seatIds,
          status: 'confirmed',
          confirmedAt
        },
        seats: updateSeats.rows,
        status: 200,
        alreadyConfirmed: false
      };
    });

    if (result.error) {
      // If holds expired during confirm, broadcast the releases
      if (result.expiredSeats && result.expiredSeats.length > 0) {
        for (const seat of result.expiredSeats) {
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
      }
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast seat updates (only if newly confirmed)
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
          booked_by: seat.booked_by
        });
      }
    }

    res.json({ booking: result.booking });
  } catch (err) {
    console.error('POST /holds/:holdId/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /holds/:holdId — release hold early ──────────────────
router.delete('/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.transaction(async (tx) => {
      // Get hold record
      const holdResult = await tx.query(
        `SELECT id, session_id, seat_ids_json, status, expires_at
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { error: 'Hold not found', status: 404 };
      }

      const hold = holdResult.rows[0];
      const seatIds = parseSeatIds(hold);

      if (hold.status === 'confirmed') {
        return { error: 'Cannot release a confirmed hold', status: 400 };
      }

      if (hold.status === 'released' || hold.status === 'expired') {
        // Idempotent: already released
        return { status: 200, seats: [], alreadyReleased: true };
      }

      // Release the seats
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const releasedSeats = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
         WHERE id IN (${seatPlaceholders})
           AND hold_id = $${seatIds.length + 1}
         RETURNING id, row_label, seat_number`,
        [...seatIds, holdId]
      );

      // Update hold status
      await tx.query(
        `UPDATE holds SET status = 'released' WHERE id = $1`,
        [holdId]
      );

      return { seats: releasedSeats.rows, status: 200 };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast releases
    if (result.seats) {
      for (const seat of result.seats) {
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
    }

    res.json({ released: true });
  } catch (err) {
    console.error('DELETE /holds/:holdId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /inventory — exact inventory counts ─────────────────────
router.get('/inventory', async (req, res) => {
  try {
    await expireStaleHolds();
    const db = await getDb();
    const result = await db.query(`
      SELECT status, COUNT(*) as count FROM seats GROUP BY status
    `);
    const inventory = { available: 0, held: 0, booked: 0 };
    for (const row of result.rows) {
      inventory[row.status] = parseInt(row.count, 10);
    }
    inventory.total = inventory.available + inventory.held + inventory.booked;
    res.json(inventory);
  } catch (err) {
    console.error('GET /inventory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
