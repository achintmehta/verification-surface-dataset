import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { initDb, getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { expireStaleHolds, startExpirySweep } from './expiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '30', 10);

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// ---- SSE endpoint ----
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');

  // Send a heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });

  addClient(res);
});

// ---- GET /api/seats ----
app.get('/api/seats', async (req, res) => {
  try {
    // First expire stale holds
    await expireStaleHolds();

    const db = await getDb();
    const { rows } = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    // Map effective status: if held but expired, report as available
    const seats = rows.map(seat => {
      if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
        return {
          ...seat,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          session_id: null,
        };
      }
      return seat;
    });

    res.json({ seats, holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- POST /api/holds ----
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    // Expire stale holds first
    await expireStaleHolds();

    const holdId = uuidv4();

    // Use a transaction with serializable isolation for correctness
    // PGLite supports transactions
    await db.query('BEGIN');

    try {
      // Check all requested seats are available
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: seats } = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
         FROM seats
         WHERE id IN (${placeholders})
         FOR UPDATE`,
        seatIds
      );

      if (seats.length !== seatIds.length) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'One or more seat IDs are invalid' });
      }

      // Check for conflicts. Consider expired holds as available.
      const conflicts = [];
      for (const seat of seats) {
        const isExpiredHold = seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date();
        if (seat.status === 'booked' || (seat.status === 'held' && !isExpiredHold)) {
          conflicts.push({
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: seat.status
          });
        }
      }

      if (conflicts.length > 0) {
        await db.query('ROLLBACK');
        return res.status(409).json({
          error: 'One or more seats are unavailable',
          conflicts
        });
      }

      // All seats are available (or expired holds). Acquire them all.
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      for (const seatId of seatIds) {
        await db.query(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3
           WHERE id = $4`,
          [holdId, expiresAt, sessionId, seatId]
        );
      }

      // Insert hold record
      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [holdId, sessionId, seatIds, expiresAt]
      );

      await db.query('COMMIT');

      // Fetch updated seats to broadcast
      const { rows: updatedSeats } = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        seatIds
      );

      // Broadcast seat updates
      for (const seat of updatedSeats) {
        broadcast('seat-update', seat);
      }

      res.status(201).json({
        holdId,
        sessionId,
        seatIds,
        expiresAt,
        seats: updatedSeats
      });
    } catch (txErr) {
      await db.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('POST /api/holds error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---- POST /api/holds/:holdId/confirm ----
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  try {
    // Expire stale holds first
    await expireStaleHolds();

    await db.query('BEGIN');

    try {
      // Look up the hold
      const { rows: holds } = await db.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holds.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holds[0];

      // Idempotent: if already confirmed, return success
      if (hold.status === 'confirmed') {
        await db.query('ROLLBACK');
        const seatIds = hold.seat_ids;
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
        const { rows: bookedSeats } = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
           FROM seats
           WHERE id IN (${placeholders})`,
          seatIds
        );
        return res.json({
          holdId,
          status: 'confirmed',
          seats: bookedSeats
        });
      }

      // Check if expired
      if (hold.status === 'expired' || new Date(hold.expires_at) <= new Date()) {
        // Mark as expired if not already
        if (hold.status !== 'expired') {
          await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
          // Release seats one by one to avoid mixed-type parameter issues
          const seatIds = hold.seat_ids;
          const released = [];
          for (const seatId of seatIds) {
            const { rows } = await db.query(
              `UPDATE seats
               SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL
               WHERE id = $1 AND status = 'held' AND hold_id = $2
               RETURNING id, row_label, seat_number`,
              [seatId, holdId]
            );
            released.push(...rows);
          }
          await db.query('COMMIT');
          for (const seat of released) {
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
        } else {
          await db.query('ROLLBACK');
        }
        return res.status(410).json({ error: 'Hold has expired' });
      }

      // Check if released
      if (hold.status === 'released') {
        await db.query('ROLLBACK');
        return res.status(410).json({ error: 'Hold was released' });
      }

      // Hold is active — confirm it
      const seatIds = hold.seat_ids;

      // Verify the seats are still held by this hold
      const { rows: heldSeats } = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id
         FROM seats
         WHERE hold_id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (heldSeats.length !== seatIds.length) {
        // Some seats no longer held by this hold
        await db.query('ROLLBACK');
        return res.status(409).json({ error: 'Some seats are no longer held by this hold' });
      }

      // Mark seats as booked
      await db.query(
        `UPDATE seats
         SET status = 'booked', booked_by = $1
         WHERE hold_id = $2`,
        [hold.session_id, holdId]
      );

      // Mark hold as confirmed
      await db.query(
        `UPDATE holds SET status = 'confirmed' WHERE id = $1`,
        [holdId]
      );

      await db.query('COMMIT');

      // Fetch updated seats
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: bookedSeats } = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, session_id, booked_by
         FROM seats
         WHERE id IN (${placeholders})`,
        seatIds
      );

      // Broadcast
      for (const seat of bookedSeats) {
        broadcast('seat-update', seat);
      }

      res.json({
        holdId,
        status: 'confirmed',
        seats: bookedSeats
      });
    } catch (txErr) {
      await db.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---- DELETE /api/holds/:holdId ----
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();

  try {
    await db.query('BEGIN');

    try {
      const { rows: holds } = await db.query(
        `SELECT id, session_id, seat_ids, expires_at, status
         FROM holds
         WHERE id = $1
         FOR UPDATE`,
        [holdId]
      );

      if (holds.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const hold = holds[0];

      // Can only release active holds
      if (hold.status !== 'active') {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: `Hold is already ${hold.status}` });
      }

      // Release the seats by hold_id
      const { rows: released } = await db.query(
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

      // Broadcast releases
      for (const seat of released) {
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

      res.json({ holdId, status: 'released', releasedSeats: released.length });
    } catch (txErr) {
      await db.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('DELETE /api/holds/:holdId error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---- GET /api/inventory ----
app.get('/api/inventory', async (req, res) => {
  try {
    await expireStaleHolds();

    const db = await getDb();
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > NOW()) as held,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) as total
      FROM seats
    `);

    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/inventory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Catch-all for SPA ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

// ---- Start server ----
async function start() {
  try {
    await initDb();
    console.log('Database initialized');

    startExpirySweep(1000);
    console.log('Expiry sweep started (1s interval)');

    app.listen(PORT, () => {
      console.log(`Backend server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
