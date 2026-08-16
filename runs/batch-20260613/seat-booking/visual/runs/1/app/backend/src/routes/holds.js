/**
 * routes/holds.js
 *
 * POST /api/holds              – create a hold (all-or-nothing)
 * POST /api/holds/:id/confirm  – confirm a hold (idempotent)
 * DELETE /api/holds/:id        – release a hold early
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { withDb, HOLD_TTL_SECONDS } from '../db.js';
import { releaseExpiredHolds, broadcastReleases } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();

// ── POST /api/holds ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array.' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  // Deduplicate
  const uniqueSeatIds = [...new Set(seatIds)];

  try {
    const result = await withDb(async (db) => {
      // 1. Release any expired holds first
      const released = await releaseExpiredHolds(db);
      broadcastReleases(released);

      // 2. Lock and check every requested seat in one atomic UPDATE.
      //    We use a CTE that:
      //      a) selects the seats we want (with FOR UPDATE to lock rows)
      //      b) updates only those that are currently 'available'
      //    Then we compare what we updated vs what we requested.

      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      // Build parameterised list
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const params = [...uniqueSeatIds];

      // Attempt to atomically mark all requested seats as held.
      // We do this in a single UPDATE … WHERE status='available' AND id IN (…).
      // If fewer rows are updated than requested, some seats were unavailable.
      const { rows: updatedSeats } = await db.query(
        `UPDATE seats
         SET status          = 'held',
             hold_id         = $${params.length + 1},
             hold_expires_at = $${params.length + 2}
         WHERE id IN (${placeholders})
           AND status = 'available'
         RETURNING id`,
        [...params, holdId, expiresAt]
      );

      const updatedIds = updatedSeats.map((r) => r.id);

      if (updatedIds.length !== uniqueSeatIds.length) {
        // Some seats were not available – roll back any partial updates
        if (updatedIds.length > 0) {
          const rollbackPlaceholders = updatedIds.map((_, i) => `$${i + 1}`).join(', ');
          await db.query(
            `UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL
             WHERE id IN (${rollbackPlaceholders})`,
            updatedIds
          );
        }

        // Identify which seats were conflicting
        const { rows: conflicting } = await db.query(
          `SELECT id, status FROM seats WHERE id IN (${placeholders})`,
          uniqueSeatIds
        );
        const conflictIds = conflicting
          .filter((s) => s.status !== 'available')
          .map((s) => s.id);

        return { conflict: true, conflictIds };
      }

      // 3. Record the hold
      await db.query(
        `INSERT INTO holds (id, session_id, expires_at, confirmed)
         VALUES ($1, $2, $3, FALSE)`,
        [holdId, sessionId, expiresAt]
      );

      return {
        conflict: false,
        hold: {
          id: holdId,
          sessionId,
          seatIds: updatedIds,
          expiresAt,
        },
      };
    });

    if (result.conflict) {
      return res.status(409).json({
        error: 'One or more seats are no longer available.',
        conflictIds: result.conflictIds,
      });
    }

    // Broadcast the new holds
    broadcast('seats_held', {
      seatIds: result.hold.seatIds,
      holdId: result.hold.id,
      expiresAt: result.hold.expiresAt,
    });

    return res.status(201).json({ hold: result.hold });
  } catch (err) {
    console.error('[POST /api/holds]', err);
    return res.status(500).json({ error: 'Failed to create hold.' });
  }
});

// ── POST /api/holds/:id/confirm ───────────────────────────────────────────────
router.post('/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    const result = await withDb(async (db) => {
      // 1. Release expired holds (but NOT this one yet – we check it explicitly)
      const released = await releaseExpiredHolds(db);
      broadcastReleases(released);

      // 2. Fetch the hold
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, expires_at, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        return { status: 'not_found' };
      }

      const hold = holdRows[0];

      // 3. Ownership check
      if (hold.session_id !== sessionId) {
        return { status: 'forbidden' };
      }

      // 4. Idempotency: already confirmed
      if (hold.confirmed) {
        const { rows: bookedSeats } = await db.query(
          `SELECT id FROM seats WHERE booked_by = $1`,
          [holdId]
        );
        return {
          status: 'already_confirmed',
          booking: {
            holdId,
            sessionId,
            seatIds: bookedSeats.map((s) => s.id),
          },
        };
      }

      // 5. Expiry check
      const now = new Date();
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= now) {
        return { status: 'expired' };
      }

      // 6. Verify seats still belong to this hold
      const { rows: heldSeats } = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        return { status: 'no_seats' };
      }

      const seatIds = heldSeats.map((s) => s.id);
      const seatPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');

      // 7. Book the seats
      await db.query(
        `UPDATE seats
         SET status = 'booked',
             hold_id = NULL,
             hold_expires_at = NULL,
             booked_by = $${seatIds.length + 1}
         WHERE id IN (${seatPlaceholders})
           AND hold_id = $${seatIds.length + 2}
           AND status = 'held'`,
        [...seatIds, holdId, holdId]
      );

      // 8. Mark hold as confirmed
      await db.query(
        `UPDATE holds SET confirmed = TRUE WHERE id = $1`,
        [holdId]
      );

      return {
        status: 'confirmed',
        booking: {
          holdId,
          sessionId,
          seatIds,
        },
      };
    });

    switch (result.status) {
      case 'not_found':
        return res.status(404).json({ error: 'Hold not found.' });
      case 'forbidden':
        return res.status(403).json({ error: 'Hold belongs to a different session.' });
      case 'expired':
        return res.status(410).json({ error: 'Hold has expired.' });
      case 'no_seats':
        return res.status(409).json({ error: 'No held seats found for this hold.' });
      case 'already_confirmed':
        // Idempotent – return the same booking
        broadcast('seats_booked', {
          seatIds: result.booking.seatIds,
          holdId: result.booking.holdId,
          sessionId: result.booking.sessionId,
        });
        return res.status(200).json({ booking: result.booking });
      case 'confirmed':
        broadcast('seats_booked', {
          seatIds: result.booking.seatIds,
          holdId: result.booking.holdId,
          sessionId: result.booking.sessionId,
        });
        return res.status(200).json({ booking: result.booking });
      default:
        return res.status(500).json({ error: 'Unexpected state.' });
    }
  } catch (err) {
    console.error('[POST /api/holds/:id/confirm]', err);
    return res.status(500).json({ error: 'Failed to confirm hold.' });
  }
});

// ── DELETE /api/holds/:id ─────────────────────────────────────────────────────
router.delete('/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    const result = await withDb(async (db) => {
      const { rows: holdRows } = await db.query(
        `SELECT id, session_id, confirmed FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdRows.length === 0) {
        return { status: 'not_found' };
      }

      const hold = holdRows[0];

      if (hold.session_id !== sessionId) {
        return { status: 'forbidden' };
      }

      if (hold.confirmed) {
        return { status: 'already_confirmed' };
      }

      // Release the seats
      const { rows: releasedSeats } = await db.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id`,
        [holdId]
      );

      // Delete the hold record
      await db.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      return {
        status: 'released',
        seatIds: releasedSeats.map((s) => s.id),
      };
    });

    switch (result.status) {
      case 'not_found':
        return res.status(404).json({ error: 'Hold not found.' });
      case 'forbidden':
        return res.status(403).json({ error: 'Hold belongs to a different session.' });
      case 'already_confirmed':
        return res.status(409).json({ error: 'Cannot release a confirmed hold.' });
      case 'released':
        broadcast('seats_released', { seatIds: result.seatIds });
        return res.status(200).json({ released: true, seatIds: result.seatIds });
      default:
        return res.status(500).json({ error: 'Unexpected state.' });
    }
  } catch (err) {
    console.error('[DELETE /api/holds/:id]', err);
    return res.status(500).json({ error: 'Failed to release hold.' });
  }
});

export default router;
