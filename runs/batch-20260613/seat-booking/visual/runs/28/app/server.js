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

// PGLite setup - persist to local dir
const dataDir = join(__dirname, '.pglite-data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new PGlite(dataDir);

let sseClients = new Set();
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes for demo, adjust as needed

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );
  `);

  // Check if seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0].count;
  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    for (let r = 0; r < rows.length; r++) {
      for (let s = 1; s <= seatsPerRow; s++) {
        const id = `${rows[r]}${s}`;
        values.push(`('${id}', '${rows[r]}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(',')}`);
    console.log('Seeded 50 seats');
  }
}

function broadcastSeatUpdate(seatId, status, extra = {}) {
  const payload = JSON.stringify({ type: 'seat_update', seatId, status, ...extra });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);

  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    for (const row of result.rows) {
      broadcastSeatUpdate(row.id, 'available');
    }
  }
  return result.rows.length;
}

app.use(cors());
app.use(express.json());

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Get all seats with effective status
app.get('/api/seats', async (req, res) => {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, 
      CASE 
        WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
        WHEN status = 'held' THEN 'available'
        ELSE status 
      END as status,
      hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  res.json({ seats: result.rows });
});

// Create hold
app.post('/api/holds', async (req, res) => {
  await releaseExpiredHolds();
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

  try {
    await db.exec('BEGIN');

    // Check all seats available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id FROM seats WHERE id IN (${placeholders}) AND status = 'available'`,
      seatIds
    );

    if (checkRes.rows.length !== seatIds.length) {
      const availableIds = checkRes.rows.map(r => r.id);
      const conflicting = seatIds.filter(id => !availableIds.includes(id));
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // Acquire all
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2} 
       WHERE id IN (${updatePlaceholders})`,
      [...seatIds, holdId, expiresAt]
    );

    await db.exec('COMMIT');

    // Broadcast updates
    for (const seatId of seatIds) {
      broadcastSeatUpdate(seatId, 'held', { holdId, expiresAt, sessionId });
    }

    res.json({
      holdId,
      seatIds,
      expiresAt,
      ttlSeconds: Math.floor(HOLD_TTL_MS / 1000)
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Confirm hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  await releaseExpiredHolds();
  const { holdId } = req.params;

  try {
    await db.exec('BEGIN');

    // Find seats for this hold that are still held and not expired
    const holdRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW()`,
      [holdId]
    );

    if (holdRes.rows.length === 0) {
      // Check if already booked (idempotent)
      const bookedRes = await db.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      if (bookedRes.rows.length > 0) {
        await db.exec('COMMIT');
        return res.json({ success: true, message: 'Already confirmed', seatIds: bookedRes.rows.map(r => r.id) });
      }
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found, expired or invalid', expired: true });
    }

    const seatIds = holdRes.rows.map(r => r.id);

    // Book them
    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = hold_id, hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1`,
      [holdId]
    );

    await db.exec('COMMIT');

    // Broadcast
    for (const seatId of seatIds) {
      broadcastSeatUpdate(seatId, 'booked');
    }

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Release hold early
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id`,
      [holdId]
    );

    for (const row of result.rows) {
      broadcastSeatUpdate(row.id, 'available');
    }

    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Periodic sweep for expired holds
setInterval(async () => {
  await releaseExpiredHolds();
}, 30000);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Frontend: http://localhost:5173 (run npm run dev in frontend/)`);
  });
}

start().catch(console.error);