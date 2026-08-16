import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '60', 10);

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── Helpers ────────────────────────────────────────────────

function generateId() {
  return crypto.randomUUID();
}

/**
 * Expire all stale holds and return the seat ids that were released.
 */
async function expireStaleHolds(db) {
  // Find holds that are past their TTL and still active
  const expiredHolds = await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
    RETURNING id, seat_ids
  `);

  if (expiredHolds.rows.length === 0) return [];

  const allExpiredSeatIds = [];
  for (const hold of expiredHolds.rows) {
    const seatIds = hold.seat_ids;
    if (seatIds && seatIds.length > 0) {
      allExpiredSeatIds.push(...seatIds);
    }
  }

  if (allExpiredSeatIds.length > 0) {
    // Release seats that belong to expired holds
    await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
      WHERE id = ANY($1::int[]) AND status = 'held'
    `, [allExpiredSeatIds]);
  }

  return allExpiredSeatIds;
}

/**
 * Broadcast seat updates for given seat ids.
 */
async function broadcastSeatUpdates(db, seatIds, eventName) {
  if (seatIds.length === 0) return;
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
    FROM seats WHERE id = ANY($1::int[])
  `, [seatIds]);

  const updates = result.rows.map(seat => ({
    id: seat.id,
    rowLabel: seat.row_label,
    seatNumber: seat.seat_number,
    status: seat.status,
    holdId: seat.hold_id,
    holdExpiresAt: seat.hold_expires_at,
    sessionId: seat.session_id
  }));

  broadcast(eventName, updates);
}

// ─── GET /api/seats ─────────────────────────────────────────

app.get('/api/seats', async (req, res) => {
  try {
    const db = await getDb();

    // Expire stale holds first
    const expiredSeatIds = await expireStaleHolds(db);
    if (expiredSeatIds.length > 0) {
      await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
    }

    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id
      FROM seats
      ORDER BY row_label, seat_number
    `);

    const seats = result.rows.map(seat => ({
      id: seat.id,
      rowLabel: seat.row_label,
      seatNumber: seat.seat_number,
      status: seat.status,
      holdId: seat.hold_id,
      holdExpiresAt: seat.hold_expires_at,
      sessionId: seat.session_id
    }));

    res.json({ seats });
  } catch (err) {
    console.error('Error fetching seats:', err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// ─── POST /api/holds ────────────────────────────────────────

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const db = await getDb();
    const holdId = generateId();

    let holdResult;

    await db.exec('BEGIN');

    try {
      // First expire any stale holds
      const expiredSeatIds = await expireStaleHolds(db);

      // Sort seat ids to prevent deadlocks
      const sortedSeatIds = [...seatIds].sort((a, b) => a - b);

      // Check that ALL requested seats exist and are currently available
      // Use FOR UPDATE to lock the rows during this transaction
      const checkResult = await db.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE id = ANY($1::int[])
        ORDER BY id
        FOR UPDATE
      `, [sortedSeatIds]);

      // Verify we found all requested seats
      if (checkResult.rows.length !== sortedSeatIds.length) {
        const foundIds = new Set(checkResult.rows.map(r => r.id));
        const missingIds = sortedSeatIds.filter(id => !foundIds.has(id));
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: 'Some seat ids do not exist', missingIds });
      }

      // Check if any seats are not available
      const unavailable = checkResult.rows.filter(r => r.status !== 'available');
      if (unavailable.length > 0) {
        const conflictingSeatIds = unavailable.map(r => r.id);
        await db.exec('ROLLBACK');

        // Broadcast expired seat updates outside of transaction if any
        if (expiredSeatIds.length > 0) {
          await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
        }

        return res.status(409).json({
          error: 'One or more seats are not available',
          conflictingSeatIds
        });
      }

      // All seats are available. Acquire them atomically.
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await db.query(`
        UPDATE seats
        SET status = 'held',
            hold_id = $1,
            hold_expires_at = $2::timestamptz,
            session_id = $3
        WHERE id = ANY($4::int[])
      `, [holdId, expiresAt, sessionId, sortedSeatIds]);

      // Insert hold record
      await db.query(`
        INSERT INTO holds (id, session_id, seat_ids, expires_at)
        VALUES ($1, $2, $3::int[], $4::timestamptz)
      `, [holdId, sessionId, sortedSeatIds, expiresAt]);

      await db.exec('COMMIT');

      // Broadcast all updates (expired + newly held)
      const allChangedIds = [...new Set([...expiredSeatIds, ...sortedSeatIds])];
      await broadcastSeatUpdates(db, allChangedIds, 'seat-update');

      holdResult = {
        holdId,
        sessionId,
        seatIds: sortedSeatIds,
        expiresAt,
        ttlSeconds: HOLD_TTL_SECONDS
      };

    } catch (txErr) {
      try { await db.exec('ROLLBACK'); } catch (_) {}
      throw txErr;
    }

    res.status(201).json(holdResult);
  } catch (err) {
    console.error('Error creating hold:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// ─── POST /api/holds/:holdId/confirm ────────────────────────

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    await db.exec('BEGIN');

    try {
      // First expire stale holds
      const expiredSeatIds = await expireStaleHolds(db);

      // Look up the hold
      const holdResult = await db.query(`
        SELECT id, session_id, seat_ids, expires_at, status
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        await db.exec('ROLLBACK');
        if (expiredSeatIds.length > 0) {
          await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
        }
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdResult.rows[0];

      // Idempotent: if already confirmed, return success
      if (hold.status === 'confirmed') {
        await db.exec('ROLLBACK');
        if (expiredSeatIds.length > 0) {
          await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
        }

        const seatsResult = await db.query(`
          SELECT id, row_label, seat_number, status, session_id
          FROM seats WHERE id = ANY($1::int[])
        `, [hold.seat_ids]);

        return res.json({
          holdId: hold.id,
          sessionId: hold.session_id,
          seatIds: hold.seat_ids,
          status: 'confirmed',
          seats: seatsResult.rows.map(s => ({
            id: s.id,
            rowLabel: s.row_label,
            seatNumber: s.seat_number,
            status: s.status
          }))
        });
      }

      // Check if hold expired or was released
      if (hold.status === 'expired' || hold.status === 'released') {
        await db.exec('ROLLBACK');
        if (expiredSeatIds.length > 0) {
          await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
        }
        return res.status(410).json({ error: `Hold has been ${hold.status}` });
      }

      // Check if hold is past TTL (might not have been caught by sweep yet)
      const expiresAt = new Date(hold.expires_at);
      if (expiresAt <= new Date()) {
        // Mark it expired
        await db.query(`
          UPDATE holds SET status = 'expired' WHERE id = $1
        `, [holdId]);

        // Release the seats
        await db.query(`
          UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
          WHERE hold_id = $1 AND status = 'held'
        `, [holdId]);

        await db.exec('COMMIT');

        const allExpired = [...new Set([...expiredSeatIds, ...hold.seat_ids])];
        await broadcastSeatUpdates(db, allExpired, 'seat-update');

        return res.status(410).json({ error: 'Hold has expired' });
      }

      // Verify that the seats are still held by this hold_id
      const seatCheck = await db.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE id = ANY($1::int[])
        FOR UPDATE
      `, [hold.seat_ids]);

      const notHeldByUs = seatCheck.rows.filter(
        s => s.status !== 'held' || s.hold_id !== holdId
      );

      if (notHeldByUs.length > 0) {
        await db.exec('ROLLBACK');
        return res.status(409).json({
          error: 'Some seats are no longer held by this hold',
          conflictingSeatIds: notHeldByUs.map(s => s.id)
        });
      }

      // Confirm: mark seats as booked
      await db.query(`
        UPDATE seats
        SET status = 'booked',
            hold_id = NULL,
            hold_expires_at = NULL,
            booked_by = $1
        WHERE id = ANY($2::int[]) AND hold_id = $3
      `, [hold.session_id, hold.seat_ids, holdId]);

      // Mark hold as confirmed
      await db.query(`
        UPDATE holds SET status = 'confirmed' WHERE id = $1
      `, [holdId]);

      await db.exec('COMMIT');

      // Broadcast updates
      const allChangedIds = [...new Set([...expiredSeatIds, ...hold.seat_ids])];
      await broadcastSeatUpdates(db, allChangedIds, 'seat-update');

      // Fetch final seat state
      const finalSeats = await db.query(`
        SELECT id, row_label, seat_number, status, session_id
        FROM seats WHERE id = ANY($1::int[])
      `, [hold.seat_ids]);

      res.json({
        holdId: hold.id,
        sessionId: hold.session_id,
        seatIds: hold.seat_ids,
        status: 'confirmed',
        seats: finalSeats.rows.map(s => ({
          id: s.id,
          rowLabel: s.row_label,
          seatNumber: s.seat_number,
          status: s.status
        }))
      });

    } catch (txErr) {
      try { await db.exec('ROLLBACK'); } catch (_) {}
      throw txErr;
    }

  } catch (err) {
    console.error('Error confirming hold:', err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

// ─── DELETE /api/holds/:holdId ──────────────────────────────

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    await db.exec('BEGIN');

    try {
      // Look up the hold
      const holdResult = await db.query(`
        SELECT id, session_id, seat_ids, status
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holdResult.rows[0];

      if (hold.status === 'confirmed') {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: 'Cannot release a confirmed hold' });
      }

      if (hold.status === 'released') {
        await db.exec('ROLLBACK');
        return res.json({ message: 'Hold already released', holdId });
      }

      // Release the seats
      await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
        WHERE hold_id = $1 AND status = 'held'
      `, [holdId]);

      // Mark hold as released
      await db.query(`
        UPDATE holds SET status = 'released' WHERE id = $1
      `, [holdId]);

      await db.exec('COMMIT');

      // Broadcast
      await broadcastSeatUpdates(db, hold.seat_ids, 'seat-update');

      res.json({ message: 'Hold released', holdId, seatIds: hold.seat_ids });

    } catch (txErr) {
      try { await db.exec('ROLLBACK'); } catch (_) {}
      throw txErr;
    }

  } catch (err) {
    console.error('Error releasing hold:', err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// ─── GET /api/stream (SSE) ─────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial keepalive
  res.write(':ok\n\n');

  addClient(res);

  // Send keepalive every 15 seconds
  const keepalive = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch (e) {
      clearInterval(keepalive);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
  });
});

// ─── GET /api/inventory ─────────────────────────────────────

app.get('/api/inventory', async (req, res) => {
  try {
    const db = await getDb();

    const expiredSeatIds = await expireStaleHolds(db);
    if (expiredSeatIds.length > 0) {
      await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
    }

    const result = await db.query(`
      SELECT status, COUNT(*) as count FROM seats GROUP BY status
    `);
    const totalResult = await db.query(`SELECT COUNT(*) as total FROM seats`);

    const inventory = { available: 0, held: 0, booked: 0 };
    for (const row of result.rows) {
      inventory[row.status] = parseInt(row.count, 10);
    }
    inventory.total = parseInt(totalResult.rows[0].total, 10);

    res.json(inventory);
  } catch (err) {
    console.error('Error fetching inventory:', err);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// ─── Periodic sweep ─────────────────────────────────────────

async function periodicSweep() {
  try {
    const db = await getDb();
    const expiredSeatIds = await expireStaleHolds(db);
    if (expiredSeatIds.length > 0) {
      console.log(`Sweep: expired ${expiredSeatIds.length} seats`);
      await broadcastSeatUpdates(db, expiredSeatIds, 'seat-update');
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

// ─── SPA fallback ───────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ─── Start server ───────────────────────────────────────────

async function start() {
  await getDb();
  console.log('Database initialized');

  // Run sweep every 5 seconds
  setInterval(periodicSweep, 5000);

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
