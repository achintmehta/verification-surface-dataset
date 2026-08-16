const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { addClient, broadcast } = require('./sse');
const { expireStaleHolds } = require('./expiry');
const { dbLock } = require('./lock');

const router = express.Router();

const HOLD_TTL_SECONDS = 30; // 30 second hold TTL

// ========== SSE endpoint ==========
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n'); // comment to establish connection
  addClient(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

// ========== GET /api/seats ==========
router.get('/seats', async (req, res) => {
  try {
    // Expire stale holds (acquires lock internally, broadcasts released seats)
    await expireStaleHolds();

    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Compute effective status (belt-and-suspenders: treat expired holds as available in response)
    const seats = result.rows.map(seat => {
      const effective = computeEffectiveStatus(seat);
      return {
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: effective,
        hold_id: effective === 'held' ? seat.hold_id : null,
        hold_expires_at: effective === 'held' ? seat.hold_expires_at : null,
        booked_by: seat.booked_by
      };
    });

    res.json({ seats });
  } catch (err) {
    console.error('GET /seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== POST /api/holds ==========
router.post('/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const uniqueSeatIds = [...new Set(seatIds.map(id => parseInt(id, 10)))];
    if (uniqueSeatIds.some(id => isNaN(id))) {
      return res.status(400).json({ error: 'Invalid seat IDs' });
    }
    uniqueSeatIds.sort((a, b) => a - b);

    const result = await dbLock.withLock(async () => {
      const db = await getDb();
      const expiredSeats = await doExpireStaleHolds(db);

      const holdId = uuidv4();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
      const ph = placeholders(uniqueSeatIds);

      // Check all target seats
      const seatResult = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats WHERE id IN (${ph})`,
        uniqueSeatIds
      );

      if (seatResult.rows.length !== uniqueSeatIds.length) {
        return { status: 400, body: { error: 'Some seat IDs do not exist' }, broadcast: expiredSeats };
      }

      // Identify conflicts (expired holds already cleared by doExpireStaleHolds)
      const conflicting = [];
      for (const seat of seatResult.rows) {
        const eff = computeEffectiveStatus(seat);
        if (eff !== 'available') {
          conflicting.push({ id: seat.id, row_label: seat.row_label, seat_number: seat.seat_number, status: eff });
        }
      }

      if (conflicting.length > 0) {
        return { status: 409, body: { error: 'Some seats are not available', conflicting }, broadcast: expiredSeats };
      }

      // Clear any lingering expired-hold metadata on these seats
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE id IN (${ph}) AND status = 'held' AND hold_expires_at <= NOW()`,
        uniqueSeatIds
      );

      // Mark seats held
      const n = uniqueSeatIds.length;
      await db.query(
        `UPDATE seats SET status = 'held', hold_id = $${n + 1}, hold_expires_at = $${n + 2}
         WHERE id IN (${ph})`,
        [...uniqueSeatIds, holdId, expiresAt]
      );

      // Insert hold record
      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status) VALUES ($1, $2, $3, $4, 'active')`,
        [holdId, sessionId, uniqueSeatIds, expiresAt]
      );

      // Fetch updated seats
      const updated = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${ph})`,
        uniqueSeatIds
      );

      return {
        status: 201,
        body: {
          hold: { id: holdId, sessionId, seatIds: uniqueSeatIds, expiresAt, status: 'active' },
          seats: updated.rows
        },
        broadcast: [...expiredSeats, ...updated.rows]
      };
    });

    broadcastSeats(result.broadcast);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /holds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== POST /api/holds/:holdId/confirm ==========
router.post('/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;

    const result = await dbLock.withLock(async () => {
      const db = await getDb();
      const expiredSeats = await doExpireStaleHolds(db);

      const holdResult = await db.query(
        `SELECT id, session_id, seat_ids, expires_at, status, confirmed_at FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' }, broadcast: expiredSeats };
      }

      const hold = holdResult.rows[0];
      const seatIds = normalizeSeatIds(hold.seat_ids);
      const ph = placeholders(seatIds);

      // Idempotent: already confirmed → return success
      if (hold.status === 'confirmed') {
        const seats = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${ph})`,
          seatIds
        );
        return {
          status: 200,
          body: {
            booking: { holdId: hold.id, sessionId: hold.session_id, seatIds, status: 'confirmed', confirmedAt: hold.confirmed_at },
            seats: seats.rows
          },
          broadcast: expiredSeats
        };
      }

      // Already expired or released by server
      if (hold.status === 'expired' || hold.status === 'released') {
        return { status: 410, body: { error: `Hold has been ${hold.status}` }, broadcast: expiredSeats };
      }

      // Check time-based expiry (status still 'active' but time passed)
      if (new Date() > new Date(hold.expires_at)) {
        await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
        const n = seatIds.length;
        await db.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE id IN (${ph}) AND hold_id = $${n + 1}`,
          [...seatIds, holdId]
        );
        const released = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${ph})`,
          seatIds
        );
        return { status: 410, body: { error: 'Hold has expired' }, broadcast: [...expiredSeats, ...released.rows] };
      }

      // Verify hold still owns its seats
      const seatCheck = await db.query(`SELECT id, status, hold_id FROM seats WHERE id IN (${ph})`, seatIds);
      const owned = seatCheck.rows.filter(s => s.hold_id === holdId && s.status === 'held');
      if (owned.length !== seatIds.length) {
        return { status: 409, body: { error: 'Hold no longer owns all its seats' }, broadcast: expiredSeats };
      }

      // Book the seats
      const n = seatIds.length;
      await db.query(
        `UPDATE seats SET status = 'booked', booked_by = $${n + 1}, hold_expires_at = NULL
         WHERE id IN (${ph}) AND hold_id = $${n + 2}`,
        [...seatIds, hold.session_id, holdId]
      );
      await db.query(`UPDATE holds SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`, [holdId]);

      const booked = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${ph})`,
        seatIds
      );
      const confirmedHold = await db.query(`SELECT confirmed_at FROM holds WHERE id = $1`, [holdId]);

      return {
        status: 200,
        body: {
          booking: { holdId: hold.id, sessionId: hold.session_id, seatIds, status: 'confirmed', confirmedAt: confirmedHold.rows[0].confirmed_at },
          seats: booked.rows
        },
        broadcast: [...expiredSeats, ...booked.rows]
      };
    });

    broadcastSeats(result.broadcast);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /holds/:holdId/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== DELETE /api/holds/:holdId ==========
router.delete('/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;

    const result = await dbLock.withLock(async () => {
      const db = await getDb();

      const holdResult = await db.query(
        `SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        return { status: 404, body: { error: 'Hold not found' }, broadcast: [] };
      }

      const hold = holdResult.rows[0];
      if (hold.status !== 'active') {
        return { status: 400, body: { error: `Cannot release hold with status: ${hold.status}` }, broadcast: [] };
      }

      const seatIds = normalizeSeatIds(hold.seat_ids);
      const ph = placeholders(seatIds);
      const n = seatIds.length;

      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE id IN (${ph}) AND hold_id = $${n + 1}`,
        [...seatIds, holdId]
      );
      await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

      const released = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${ph})`,
        seatIds
      );

      return {
        status: 200,
        body: { message: 'Hold released', seats: released.rows },
        broadcast: released.rows
      };
    });

    broadcastSeats(result.broadcast);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('DELETE /holds/:holdId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== Internal helpers ==========

/**
 * Expire stale holds within an already-acquired lock.
 * Returns array of released seat objects for broadcasting.
 */
async function doExpireStaleHolds(db) {
  const result = await db.query(`
    UPDATE holds SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
    RETURNING id, seat_ids
  `);

  if (result.rows.length === 0) return [];

  const allSeatIds = [];
  const holdIds = [];

  for (const hold of result.rows) {
    holdIds.push(hold.id);
    allSeatIds.push(...normalizeSeatIds(hold.seat_ids));
  }

  if (allSeatIds.length > 0) {
    const hp = placeholders(holdIds);
    await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id IN (${hp}) AND status = 'held'`,
      holdIds
    );

    const sp = placeholders(allSeatIds);
    const released = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${sp})`,
      allSeatIds
    );
    return released.rows;
  }

  return [];
}

function computeEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at) {
    if (new Date(seat.hold_expires_at) <= new Date()) return 'available';
  }
  return seat.status;
}

function normalizeSeatIds(val) {
  if (Array.isArray(val)) return val.map(v => parseInt(v, 10));
  if (typeof val === 'string') {
    const inner = val.replace(/^\{|\}$/g, '');
    if (!inner) return [];
    return inner.split(',').map(s => parseInt(s.trim(), 10));
  }
  return [];
}

function placeholders(arr) {
  return arr.map((_, i) => `$${i + 1}`).join(', ');
}

function broadcastSeats(seats) {
  if (!seats || seats.length === 0) return;
  for (const seat of seats) {
    broadcast('seat-update', {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: seat.status,
      hold_id: seat.hold_id,
      hold_expires_at: seat.hold_expires_at,
      booked_by: seat.booked_by
    });
  }
}

module.exports = router;
