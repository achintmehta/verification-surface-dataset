import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { setTimeout as sleep } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, '../data/pglite');
fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

app.use(cors());
app.use(express.json());

// Initialize PGLite with file persistence
const db = new PGlite(join(__dirname, '../data/pglite'));

let sseClients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

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

  // Check if seats exist, seed if not
  const count = await db.query('SELECT COUNT(*) as count FROM seats');
  if (count.rows[0].count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    for (const row of rows) {
      for (let num = 1; num <= seatsPerRow; num++) {
        const id = `${row}${num}`;
        values.push(`('${id}', '${row}', ${num}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(', ')}
    `);
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
    for (const seat of result.rows) {
      broadcast({
        type: 'seat-update',
        seat: { ...seat, status: 'available' }
      });
    }
  }
  return result.rows.length;
}

async function getEffectiveSeats() {
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
  return result.rows.map(row => ({
    id: row.id,
    row_label: row.row_label,
    seat_number: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    expiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).getTime() : null,
    bookedBy: row.booked_by
  }));
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getEffectiveSeats();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await releaseExpiredHolds();

  const holdId = `hold-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

  try {
    await db.exec('BEGIN');

    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id FROM seats WHERE id IN (${placeholders}) AND status != 'available'`,
      seatIds
    );

    if (checkResult.rows.length > 0) {
      const conflicting = checkResult.rows.map(r => r.id);
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // Atomic update all to held
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
       WHERE id IN (${updatePlaceholders})`,
      [...seatIds, holdId, expiresAt.toISOString()]
    );

    await db.exec('COMMIT');

    // Broadcast updates
    for (const seatId of seatIds) {
      broadcast({
        type: 'seat-update',
        seat: {
          id: seatId,
          status: 'held',
          holdId,
          expiresAt: expiresAt.getTime()
        }
      });
    }

    res.json({
      holdId,
      seatIds,
      expiresAt: expiresAt.getTime(),
      ttl: HOLD_TTL_MS,
      sessionId
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Find seats for this hold
    const holdResult = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const now = new Date();
    const expired = holdResult.rows.some(row => 
      row.status !== 'held' || new Date(row.hold_expires_at) < now
    );

    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }

    // Idempotency: if already booked by this hold, return success
    const alreadyBooked = holdResult.rows.every(r => r.status === 'booked');
    if (alreadyBooked) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, message: 'Already confirmed', holdId });
    }

    // Book them
    const seatIds = holdResult.rows.map(r => r.id);
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $2 
       WHERE hold_id = $1`,
      [holdId, `session-${holdId}`]
    );

    await db.exec('COMMIT');

    // Broadcast
    for (const seatId of seatIds) {
      broadcast({
        type: 'seat-update',
        seat: { id: seatId, status: 'booked' }
      });
    }

    res.json({ success: true, holdId, bookedSeats: seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id`,
      [holdId]
    );

    if (result.rows.length > 0) {
      for (const row of result.rows) {
        broadcast({
          type: 'seat-update',
          seat: { id: row.id, status: 'available' }
        });
      }
    }

    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// GET /api/stream - SSE
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

// Periodic sweep for expired holds
setInterval(async () => {
  const released = await releaseExpiredHolds();
  if (released > 0) {
    broadcast({ type: 'seats-refresh' });
  }
}, 30000);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);