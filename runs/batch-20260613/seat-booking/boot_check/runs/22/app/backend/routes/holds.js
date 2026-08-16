import { Router } from 'express';
import { getDb } from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { expireHolds } from '../services/expiry.js';

const HOLD_TTL_SECONDS = 30; // 30 second hold TTL

export function createHoldRoutes(broadcastSeatChanges) {
  const router = Router();

  /**
   * POST /api/holds
   * Body: { seatIds: number[], sessionId: string }
   * Atomically place a hold on ALL requested seats.
   * All-or-nothing: if any seat is unavailable, none are held.
   */
  router.post('/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const db = getDb();

    try {
      // Expire stale holds first
      const released = await expireHolds();
      if (released.length > 0) {
        broadcastSeatChanges(released);
      }

      // Use a transaction for atomicity
      const holdId = uuidv4();
      const result = await db.transaction(async (tx) => {
        // Sort seat IDs to prevent deadlocks
        const sortedSeatIds = [...seatIds].sort((a, b) => a - b);
        const placeholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(', ');

        // Check all requested seats are available
        const checkResult = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
           FROM seats 
           WHERE id IN (${placeholders})
           ORDER BY id`,
          sortedSeatIds
        );

        if (checkResult.rows.length !== sortedSeatIds.length) {
          const foundIds = new Set(checkResult.rows.map(r => r.id));
          const missingIds = sortedSeatIds.filter(id => !foundIds.has(id));
          return { error: 'invalid_seats', missingIds };
        }

        // Check for unavailable seats (considering expiry)
        const conflicting = [];
        for (const seat of checkResult.rows) {
          const isExpiredHold = seat.status === 'held' && 
            seat.hold_expires_at && 
            new Date(seat.hold_expires_at) <= new Date();
          
          if (seat.status !== 'available' && !isExpiredHold) {
            conflicting.push({
              id: seat.id,
              row_label: seat.row_label,
              seat_number: seat.seat_number,
              status: seat.status,
            });
          }
        }

        if (conflicting.length > 0) {
          return { error: 'conflict', conflicting };
        }

        // Release any expired holds on these seats (within transaction)
        for (const seat of checkResult.rows) {
          const isExpiredHold = seat.status === 'held' && 
            seat.hold_expires_at && 
            new Date(seat.hold_expires_at) <= new Date();
          if (isExpiredHold && seat.hold_id) {
            await tx.query(
              `UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`,
              [seat.hold_id]
            );
          }
        }

        // Place holds on all seats
        const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

        for (const seatId of sortedSeatIds) {
          await tx.query(
            `UPDATE seats 
             SET status = 'held', hold_id = $1, hold_expires_at = $2
             WHERE id = $3`,
            [holdId, expiresAt, seatId]
          );
        }

        // Create the hold record
        await tx.query(
          `INSERT INTO holds (id, session_id, seat_ids, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [holdId, sessionId, sortedSeatIds, expiresAt]
        );

        // Fetch updated seats for response
        const updatedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats WHERE id IN (${placeholders})
           ORDER BY row_label, seat_number`,
          sortedSeatIds
        );

        return {
          success: true,
          holdId,
          expiresAt,
          seats: updatedSeats.rows,
        };
      });

      if (result.error === 'conflict') {
        return res.status(409).json({
          error: 'Some seats are not available',
          conflicting: result.conflicting,
        });
      }

      if (result.error === 'invalid_seats') {
        return res.status(400).json({
          error: 'Some seat IDs do not exist',
          missingIds: result.missingIds,
        });
      }

      // Broadcast the seat changes
      broadcastSeatChanges(result.seats);

      return res.status(201).json({
        holdId: result.holdId,
        expiresAt: result.expiresAt,
        seats: result.seats,
        ttlSeconds: HOLD_TTL_SECONDS,
      });
    } catch (err) {
      console.error('Error creating hold:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/holds/:holdId/confirm
   * Confirm a hold, booking all its seats permanently.
   * Idempotent: confirming an already-confirmed hold returns the same result.
   */
  router.post('/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;
    const db = getDb();

    try {
      // Expire stale holds first
      const released = await expireHolds();
      if (released.length > 0) {
        broadcastSeatChanges(released);
      }

      const result = await db.transaction(async (tx) => {
        // Look up the hold
        const holdResult = await tx.query(
          `SELECT id, session_id, seat_ids, expires_at, status
           FROM holds WHERE id = $1`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { error: 'not_found' };
        }

        const hold = holdResult.rows[0];

        // Idempotent: if already confirmed, return success
        if (hold.status === 'confirmed') {
          const idempotentPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
          const seats = await tx.query(
            `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats WHERE id IN (${idempotentPlaceholders})
             ORDER BY row_label, seat_number`,
            hold.seat_ids
          );

          return { success: true, alreadyConfirmed: true, seats: seats.rows, hold };
        }

        // Check if expired
        if (hold.status === 'expired' || new Date(hold.expires_at) <= new Date()) {
          // Mark as expired if not already
          if (hold.status === 'active') {
            await tx.query(
              `UPDATE holds SET status = 'expired' WHERE id = $1`,
              [holdId]
            );
            // Release the seats
            const seatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
            await tx.query(
              `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
               WHERE id IN (${seatPlaceholders}) AND hold_id = $${hold.seat_ids.length + 1}`,
              [...hold.seat_ids, holdId]
            );
          }
          return { error: 'expired' };
        }

        if (hold.status !== 'active') {
          return { error: 'invalid_status', status: hold.status };
        }

        // Verify this hold still owns all the seats
        const seatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
        const seatCheck = await tx.query(
          `SELECT id, status, hold_id FROM seats 
           WHERE id IN (${seatPlaceholders})`,
          hold.seat_ids
        );

        // Verify all seats are still held by this hold
        for (const seat of seatCheck.rows) {
          if (seat.status !== 'held' || seat.hold_id !== holdId) {
            return { error: 'seats_lost' };
          }
        }

        // Book the seats
        // $1 = session_id (booked_by), $2..$(N+1) = seat_ids, $(N+2) = holdId
        const bookSeatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 2}`).join(', ');
        await tx.query(
          `UPDATE seats 
           SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $1
           WHERE id IN (${bookSeatPlaceholders}) AND hold_id = $${hold.seat_ids.length + 2}`,
          [hold.session_id, ...hold.seat_ids, holdId]
        );

        // Mark hold as confirmed
        await tx.query(
          `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
          [holdId]
        );

        // Fetch updated seats
        const updatedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats WHERE id IN (${seatPlaceholders})
           ORDER BY row_label, seat_number`,
          hold.seat_ids
        );

        return { success: true, seats: updatedSeats.rows, hold };
      });

      if (result.error === 'not_found') {
        return res.status(404).json({ error: 'Hold not found' });
      }
      if (result.error === 'expired') {
        return res.status(410).json({ error: 'Hold has expired' });
      }
      if (result.error === 'invalid_status') {
        return res.status(400).json({ error: `Hold is ${result.status}` });
      }
      if (result.error === 'seats_lost') {
        return res.status(409).json({ error: 'Hold seats are no longer held by this hold' });
      }

      // Broadcast seat changes (only if not already confirmed - avoid duplicate broadcasts)
      if (!result.alreadyConfirmed) {
        broadcastSeatChanges(result.seats);
      }

      return res.json({
        holdId,
        status: 'confirmed',
        seats: result.seats,
      });
    } catch (err) {
      console.error('Error confirming hold:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/holds/:holdId
   * Release a hold early, returning seats to available.
   */
  router.delete('/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;
    const db = getDb();

    try {
      const result = await db.transaction(async (tx) => {
        const holdResult = await tx.query(
          `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1`,
          [holdId]
        );

        if (holdResult.rows.length === 0) {
          return { error: 'not_found' };
        }

        const hold = holdResult.rows[0];

        if (hold.status !== 'active') {
          return { error: 'not_active', status: hold.status };
        }

        // Release the seats
        const seatPlaceholders = hold.seat_ids.map((_, i) => `$${i + 1}`).join(', ');
        await tx.query(
          `UPDATE seats 
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE id IN (${seatPlaceholders}) AND hold_id = $${hold.seat_ids.length + 1}`,
          [...hold.seat_ids, holdId]
        );

        // Mark hold as released
        await tx.query(
          `UPDATE holds SET status = 'released' WHERE id = $1`,
          [holdId]
        );

        // Fetch updated seats
        const updatedSeats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats WHERE id IN (${seatPlaceholders})
           ORDER BY row_label, seat_number`,
          hold.seat_ids
        );

        return { success: true, seats: updatedSeats.rows };
      });

      if (result.error === 'not_found') {
        return res.status(404).json({ error: 'Hold not found' });
      }
      if (result.error === 'not_active') {
        return res.status(400).json({ error: `Hold is ${result.status}` });
      }

      broadcastSeatChanges(result.seats);

      return res.json({ released: true, seats: result.seats });
    } catch (err) {
      console.error('Error releasing hold:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
