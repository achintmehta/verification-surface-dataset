import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite(join(DATA_DIR, 'booking.db'));

// SSE clients
let sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Check if seats are seeded
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = parseInt(result.rows[0].count, 10);
  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (const row of rows) {
      for (let num = 1; num <= seatsPerRow; num++) {
        await db.query(
          'INSERT INTO seats (row_label, seat_number, status) VALUES ($1, $2, $3)',
          [row, num, 'available']
        );
      }
    }
    console.log('Seeded 50 seats');
  }
}

async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, row_label, seat_number
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    broadcast('seats-released', { seats: result.rows });
  }
  return result.rows;
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
             WHEN status = 'booked' THEN 'booked'
             ELSE 'available'
           END as effective_status,
           hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

// API: Get all seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// API: Create hold
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'seatIds array and sessionId required' });
  }

  try {
    await releaseExpiredHolds();

    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL

    // Use transaction for atomicity
    await db.exec('BEGIN');
    try {
      // Check all seats are available
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkResult = await db.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id = ANY(ARRAY[${placeholders}]::int[])`,
        seatIds
      );

      const unavailable = [];
      for (const seat of checkResult.rows) {
        const isHeldValid = seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date();
        if (seat.status === 'booked' || isHeldValid) {
          unavailable.push(seat.id);
        }
      }

      if (unavailable.length > 0) {
        await db.exec('ROLLBACK');
        return res.status(409).json({ error: 'Some seats unavailable', conflictingSeatIds: unavailable });
      }

      // Acquire all
      for (const seatId of seatIds) {
        await db.query(
          `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = $3`,
          [holdId, expiresAt, seatId]
        );
      }

      await db.exec('COMMIT');

      const heldSeats = await db.query(
        `SELECT id, row_label, seat_number FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      broadcast('seats-held', { holdId, sessionId, seats: heldSeats.rows, expiresAt });

      res.status(201).json({
        holdId,
        expiresAt,
        seats: heldSeats.rows
      });
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// API: Confirm hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await releaseExpiredHolds();

    await db.exec('BEGIN');
    try {
      // Check hold validity
      const holdResult = await db.query(
        `SELECT hold_id, status, hold_expires_at FROM seats WHERE hold_id = $1 LIMIT 1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const seat = holdResult.rows[0];
      if (seat.status !== 'held' || (seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date())) {
        await db.exec('ROLLBACK');
        return res.status(410).json({ error: 'Hold expired or invalid' });
      }

      // Idempotency: if already booked by this hold? But since we set booked_by, check if already confirmed
      const alreadyBooked = await db.query(
        `SELECT COUNT(*) as count FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      if (parseInt(alreadyBooked.rows[0].count, 10) > 0) {
        // Already confirmed, return success idempotently
        const bookedSeats = await db.query(
          `SELECT id, row_label, seat_number, booked_by FROM seats WHERE hold_id = $1`,
          [holdId]
        );
        await db.exec('COMMIT');
        return res.json({ success: true, message: 'Already confirmed', seats: bookedSeats.rows });
      }

      // Confirm: book them
      await db.query(
        `UPDATE seats SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $2`,
        [sessionId, holdId]
      );

      const bookedSeats = await db.query(
        `SELECT id, row_label, seat_number FROM seats WHERE booked_by = $1`,
        [sessionId]
      );

      await db.exec('COMMIT');

      broadcast('seats-booked', { holdId, sessionId, seats: bookedSeats.rows });

      res.json({ success: true, seats: bookedSeats.rows });
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

// API: Release hold early
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number`,
      [holdId]
    );

    if (result.rows.length > 0) {
      broadcast('seats-released', { holdId, seats: result.rows });
    }

    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);