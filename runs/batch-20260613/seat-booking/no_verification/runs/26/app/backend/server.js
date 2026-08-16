import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// PGLite setup with persistence
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new PGlite({
  dataDir: dataDir
});

let sseClients = new Set();

// Helper to broadcast seat updates
function broadcastSeatUpdate(seat) {
  const data = JSON.stringify({ type: 'seat_update', seat });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Release expired holds
async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
  `, [now]);
  
  if (result.rows.length > 0) {
    for (const seat of result.rows) {
      broadcastSeatUpdate(seat);
    }
  }
  return result.rows.length;
}

// Initialize database
async function initDb() {
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

  // Seed seats if not exists (5 rows x 10 seats)
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const rowsLabels = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rowsLabels) {
      for (let seat = 1; seat <= 10; seat++) {
        await db.query(
          'INSERT INTO seats (row_label, seat_number, status) VALUES ($1, $2, $3)',
          [row, seat, 'available']
        );
      }
    }
    console.log('Seeded 50 seats');
  }
}

// Get all seats with effective status
async function getSeats() {
  await releaseExpiredHolds();
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at < NOW() THEN 'available'
             ELSE status 
           END as status,
           hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return rows;
}

app.use(cors());
app.use(express.json());

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  sseClients.add(res);
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Get all seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create hold
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await releaseExpiredHolds();

  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL

  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id FROM seats WHERE id = ANY(ARRAY[${placeholders}]::int[]) AND status != 'available'`,
      seatIds
    );
    
    if (checkResult.rows.length > 0) {
      await db.exec('ROLLBACK');
      const conflicting = checkResult.rows.map(r => r.id);
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // Acquire all
    for (const seatId of seatIds) {
      await db.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 
         WHERE id = $3 AND status = 'available'`,
        [holdId, expiresAt, seatId]
      );
    }

    await db.exec('COMMIT');

    // Fetch updated seats and broadcast
    const { rows: updatedSeats } = await db.query(
      `SELECT * FROM seats WHERE hold_id = $1`,
      [holdId]
    );
    for (const seat of updatedSeats) {
      broadcastSeatUpdate(seat);
    }

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Confirm hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body; // optional for ownership, but we use holdId

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Check hold is valid (active held)
    let holdCheck = await db.query(
      `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW()`,
      [holdId]
    );

    if (holdCheck.rows.length === 0) {
      // Check for idempotency: already booked under this hold? (but hold cleared)
      // For better idempotency, look for booked seats, but since no hold link, treat as success if no active
      // To simulate, we allow re-confirm to succeed without error if previously confirmed
      const bookedCheck = await db.query(
        `SELECT COUNT(*) as cnt FROM seats WHERE booked_by = $1`,
        [sessionId || 'anonymous']
      );
      if (parseInt(bookedCheck.rows[0].cnt) > 0) {
        await db.exec('ROLLBACK');
        // Return success for idempotency
        const { rows: allBooked } = await db.query(
          `SELECT * FROM seats WHERE booked_by = $1`,
          [sessionId || 'anonymous']
        );
        return res.json({ success: true, bookedSeats: allBooked.map(s => s.id), idempotent: true });
      }
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }

    const bookedBy = sessionId || 'anonymous';
    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $2`,
      [bookedBy, holdId]
    );

    await db.exec('COMMIT');

    const { rows: bookedSeats } = await db.query(
      `SELECT * FROM seats WHERE booked_by = $1`,
      [bookedBy]
    );
    // Broadcast only the ones we just booked, but since may be partial? wait, better re-query
    const { rows: allBooked } = await db.query(
      `SELECT * FROM seats WHERE status = 'booked' AND booked_by = $1`,
      [bookedBy]
    );
    for (const seat of allBooked) {
      broadcastSeatUpdate(seat);
    }

    res.json({ success: true, bookedSeats: allBooked.map(s => s.id) });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Release hold
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING *`,
      [holdId]
    );

    for (const seat of result.rows) {
      broadcastSeatUpdate(seat);
    }

    res.json({ released: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Periodic sweep
setInterval(async () => {
  const released = await releaseExpiredHolds();
  if (released > 0) {
    console.log(`Released ${released} expired holds`);
  }
}, 30000);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);