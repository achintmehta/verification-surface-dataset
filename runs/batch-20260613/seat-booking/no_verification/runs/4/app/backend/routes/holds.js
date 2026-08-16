import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';

const router = Router();

const HOLD_TTL_SECONDS = 60; // seats held for 60 seconds

// ---------------------------------------------------------------------------
// POST /api/holds
// Body: { seatIds: string[], sessionId: string }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Deduplicate
  const uniqueSeatIds = [...new Set(seatIds)];

  const db = await getDb();

  try {
    // Run everything inside a transaction so the check-and-set is atomic
    const outcome = await db.transaction(async (tx) => {
      // 1. Expire stale holds first (inside the transaction)
      await expireHoldsInTx(tx);

      // 2. Lock and read the requested seats FOR UPDATE
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const seatResult = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at
         FROM   seats
         WHERE  id IN (${placeholders})
         FOR UPDATE`,
        uniqueSeatIds
      );

      // Check all requested seats exist
      if (seatResult.rows.length !== uniqueSeatIds.length) {
        const found = new Set(seatResult.rows.map((r) => r.id));
        const missing = uniqueSeatIds.filter((id) => !found.has(id));
        return { status: 404, body: { error: 'Unknown seat ids', missing } };
      }

      // 3. Find any unavailable seats
      const unavailable = seatResult.rows.filter((s) => s.status !== 'available');

      if (unavailable.length > 0) {
        return {
          status: 409,
          body: {
            error: 'One or more seats are unavailable',
            conflictingSeatIds: unavailable.map((s) => s.id),
          },
        };
      }

      // 4. All seats are available – create the hold
      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);

      await tx.query(
        `INSERT INTO holds (id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [holdId, sessionId, expiresAt.toISOString()]
      );

      // 5. Mark each seat as held
      await tx.query(
        `UPDATE seats
         SET    status          = 'held',
                hold_id         = $1,
                hold_expires_at = $2
         WHERE  id IN (${placeholders})`,
        [holdId, expiresAt.toISOString(), ...uniqueSeatIds]
      );

      return {
        status: 201,
        body: {
          holdId,
          sessionId,
          seatIds: uniqueSeatIds,
          expiresAt: expiresAt.toISOString(),
          ttlSeconds: HOLD_TTL_SECONDS,
        },
      };
    });

    // Broadcast outside the transaction (after commit)
    if (outcome.status === 201) {
      const { holdId, expiresAt } = outcome.body;
      for (const seatId of uniqueSeatIds) {
        broadcast('seat:held', {
          seatId,
          status: 'held',
          holdId,
          holdExpiresAt: expiresAt,
          bookedBy: null,
        });
      }
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('POST /api/holds error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm
// Body: { sessionId: string }
// ---------------------------------------------------------------------------
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const outcome = await db.transaction(async (tx) => {
      // 1. Expire stale holds
      await expireHoldsInTx(tx);

      // 2. Fetch the hold (lock it)
      const holdResult = await tx.query(
        `SELECT id, session_id, expires_at, confirmed
         FROM   holds
         WHERE  id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { status: 404, body: { error: 'Hold not found or already expired' } };
      }

      const hold = holdResult.rows[0];

      // 3. Ownership check
      if (hold.session_id !== sessionId) {
        return { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      // 4. Expiry check (belt-and-suspenders; expireHoldsInTx already ran)
      if (new Date(hold.expires_at) <= new Date()) {
        return { status: 410, body: { error: 'Hold has expired' } };
      }

      // 5. Idempotency: already confirmed
      if (hold.confirmed) {
        // Return the already-booked seats
        const seatsResult = await tx.query(
          `SELECT id, row_label, seat_number, status, booked_by
           FROM   seats
           WHERE  booked_by = $1`,
          [holdId]
        );
        return {
          status: 200,
          body: {
            message: 'Already confirmed',
            holdId,
            seatIds: seatsResult.rows.map((s) => s.id),
            seats: seatsResult.rows,
          },
          alreadyConfirmed: true,
        };
      }

      // 6. Fetch and lock the seats belonging to this hold
      const seatsResult = await tx.query(
        `SELECT id, status, hold_id
         FROM   seats
         WHERE  hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (seatsResult.rows.length === 0) {
        return { status: 409, body: { error: 'No seats found for this hold' } };
      }

      // Verify all seats are still held by this hold
      const badSeats = seatsResult.rows.filter(
        (s) => s.status !== 'held' || s.hold_id !== holdId
      );
      if (badSeats.length > 0) {
        return {
          status: 409,
          body: {
            error: 'Some seats are no longer held by this hold',
            badSeatIds: badSeats.map((s) => s.id),
          },
        };
      }

      // 7. Book the seats
      await tx.query(
        `UPDATE seats
         SET    status          = 'booked',
                hold_id         = NULL,
                hold_expires_at = NULL,
                booked_by       = $1
         WHERE  hold_id = $2`,
        [holdId, holdId]
      );

      // 8. Mark hold as confirmed
      await tx.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return {
        status: 200,
        body: {
          message: 'Booking confirmed',
          holdId,
          sessionId,
          seatIds: seatsResult.rows.map((s) => s.id),
        },
        bookedSeatIds: seatsResult.rows.map((s) => s.id),
      };
    });

    // Broadcast outside the transaction
    if (outcome.bookedSeatIds) {
      for (const seatId of outcome.bookedSeatIds) {
        broadcast('seat:booked', {
          seatId,
          status: 'booked',
          holdId: null,
          holdExpiresAt: null,
          bookedBy: holdId,
        });
      }
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId
// Body: { sessionId: string }
// ---------------------------------------------------------------------------
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    const outcome = await db.transaction(async (tx) => {
      // Fetch the hold
      const holdResult = await tx.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' } };
      }

      const hold = holdResult.rows[0];

      if (hold.session_id !== sessionId) {
        return { status: 403, body: { error: 'Hold belongs to a different session' } };
      }

      if (hold.confirmed) {
        return { status: 409, body: { error: 'Cannot release a confirmed hold' } };
      }

      // Release the seats
      const seatsResult = await tx.query(
        `UPDATE seats
         SET    status          = 'available',
                hold_id         = NULL,
                hold_expires_at = NULL
         WHERE  hold_id = $1
         RETURNING id`,
        [holdId]
      );

      // Delete the hold
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return {
        status: 200,
        body: { message: 'Hold released', holdId },
        releasedSeatIds: seatsResult.rows.map((s) => s.id),
      };
    });

    if (outcome.releasedSeatIds) {
      for (const seatId of outcome.releasedSeatIds) {
        broadcast('seat:released', {
          seatId,
          status: 'available',
          holdId: null,
          holdExpiresAt: null,
          bookedBy: null,
        });
      }
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('DELETE /api/holds/:holdId error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Helper: expire holds inside an existing transaction object.
// Uses a CTE to capture the old hold_id before NULLing it.
// ---------------------------------------------------------------------------
async function expireHoldsInTx(tx) {
  const result = await tx.query(`
    WITH expired AS (
      SELECT id, hold_id
      FROM   seats
      WHERE  status = 'held'
        AND  hold_expires_at IS NOT NULL
        AND  hold_expires_at <= NOW()
    )
    UPDATE seats s
    SET    status          = 'available',
           hold_id         = NULL,
           hold_expires_at = NULL
    FROM   expired e
    WHERE  s.id = e.id
    RETURNING s.id, e.hold_id AS old_hold_id
  `);

  const freed = result.rows;

  if (freed.length > 0) {
    const expiredHoldIds = [...new Set(freed.map((s) => s.old_hold_id).filter(Boolean))];
    if (expiredHoldIds.length > 0) {
      const placeholders = expiredHoldIds.map((_, i) => `$${i + 1}`).join(', ');
      await tx.query(
        `DELETE FROM holds WHERE id IN (${placeholders})`,
        expiredHoldIds
      );
    }

    // Broadcast releases so all SSE clients update immediately
    for (const seat of freed) {
      broadcast('seat:released', {
        seatId: seat.id,
        status: 'available',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: null,
      });
    }
  }

  return freed;
}

export default router;
