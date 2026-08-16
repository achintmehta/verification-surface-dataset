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
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Ensure data directory
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new PGlite(join(dataDir, 'seats.db'));

let sseClients = new Set();

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
  if (parseInt(countRes.rows[0].count) === 0) {
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

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
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
    const releasedIds = result.rows.map(r => r.id);
    console.log('Released expired holds:', releasedIds);
    broadcast('seats-updated', { released: releasedIds, status: 'available' });
  }
  return result.rows.length;
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows.map(row => {
    let effectiveStatus = row.status;
    if (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date()) {
      effectiveStatus = 'available';
    }
    return {
      id: row.id,
      row: row.row_label,
      number: row.seat_number,
      status: effectiveStatus,
      holdId: row.hold_id,
      expiresAt: row.hold_expires_at,
      bookedBy: row.booked_by
    };
  });
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
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Get all seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
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
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

  try {
    await db.exec('BEGIN');

    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE id IN (${placeholders})
    `, seatIds);

    const unavailable = [];
    for (const seat of checkRes.rows) {
      if (seat.status !== 'available' || 
          (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date())) {
        unavailable.push(seat.id);
      }
    }

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: unavailable });
    }

    // Acquire all
    for (const seatId of seatIds) {
      await db.query(`
        UPDATE seats 
        SET status = 'held', hold_id = $1, hold_expires_at = $2
        WHERE id = $3 AND status = 'available'
      `, [holdId, expiresAt, seatId]);
    }

    await db.exec('COMMIT');

    broadcast('seats-updated', { seatIds, status: 'held', holdId, expiresAt, sessionId });

    res.json({ 
      holdId, 
      expiresAt, 
      seatIds,
      ttlMs: HOLD_TTL_MS 
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// Confirm hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Check hold validity
    const holdRes = await db.query(`
      SELECT id, status, hold_id, hold_expires_at FROM seats 
      WHERE hold_id = $1
    `, [holdId]);

    if (holdRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const expiresAt = holdRes.rows[0].hold_expires_at;
    if (expiresAt && new Date(expiresAt) < new Date()) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired' });
    }

    // Verify all seats still held by this hold
    const allHeld = holdRes.rows.every(r => r.hold_id === holdId && r.status === 'held');
    if (!allHeld) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Hold state inconsistent' });
    }

    // Idempotency: if already booked, return success
    const bookedCheck = await db.query(`
      SELECT COUNT(*) as booked_count FROM seats 
      WHERE hold_id = $1 AND status = 'booked'
    `, [holdId]);
    if (parseInt(bookedCheck.rows[0].booked_count) === holdRes.rows.length) {
      await db.exec('COMMIT');
      return res.json({ success: true, message: 'Already confirmed', holdId });
    }

    // Book them
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $2
    `, [sessionId, holdId]);

    await db.exec('COMMIT');

    const bookedSeats = holdRes.rows.map(r => r.id);
    broadcast('seats-updated', { seatIds: bookedSeats, status: 'booked', holdId, sessionId });

    res.json({ success: true, holdId, bookedSeats });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

// Release hold early
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id
    `, [holdId]);

    if (result.rows.length > 0) {
      const released = result.rows.map(r => r.id);
      broadcast('seats-updated', { seatIds: released, status: 'available' });
    }

    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// Periodic sweep
setInterval(async () => {
  await releaseExpiredHolds();
}, 30000);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);