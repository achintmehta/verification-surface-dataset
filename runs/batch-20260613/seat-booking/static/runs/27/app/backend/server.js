import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, 'seats.db');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// PGLite instance
let db;
let sseClients = new Set();

// TTL in seconds
const HOLD_TTL_SECONDS = 60;

// Initialize database
async function initDb() {
  const exists = fs.existsSync(DB_PATH);
  db = new PGlite(DB_PATH);

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

  // Create index for performance
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_seats_hold ON seats(hold_id);`);

  if (!exists) {
    // Seed 5 rows x 10 seats
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    for (const row of rows) {
      for (let num = 1; num <= 10; num++) {
        const id = `${row}${num}`;
        values.push(`('${id}', '${row}', ${num}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(', ')}
    `);
    console.log('Seeded 50 seats');
  } else {
    console.log('Database loaded from disk');
  }

  // Start periodic expiry sweep
  setInterval(expireStaleHolds, 10000);
}

// Expire stale holds and broadcast
async function expireStaleHolds(broadcast = true) {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);

  if (result.rows.length > 0 && broadcast) {
    const releasedIds = result.rows.map(r => r.id);
    console.log(`Expired holds for seats: ${releasedIds.join(', ')}`);
    broadcastUpdate(releasedIds, 'released');
  }
  return result.rows.length;
}

// Get effective seats (with expiry check)
async function getSeats() {
  await expireStaleHolds(false);
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
    expiresAt: row.hold_expires_at
  }));
}

// Broadcast seat updates to all SSE clients
function broadcastUpdate(seatIds, action = 'update') {
  if (sseClients.size === 0) return;

  // Fetch latest for those seats
  db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at
    FROM seats WHERE id = ANY($1)
  `, [seatIds]).then(result => {
    const payload = JSON.stringify({
      type: 'seat-update',
      action,
      seats: result.rows.map(r => ({
        id: r.id,
        row_label: r.row_label,
        seat_number: r.seat_number,
        status: r.status,
        holdId: r.hold_id,
        expiresAt: r.hold_expires_at
      }))
    });

    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }).catch(console.error);
}

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

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    const counts = { available: 0, held: 0, booked: 0 };
    seats.forEach(s => counts[s.status] = (counts[s.status] || 0) + 1);
    res.json({ seats, total: seats.length, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// POST /api/holds - atomic acquire
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await expireStaleHolds(true);

  try {
    // Use transaction for atomicity
    await db.exec('BEGIN');

    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE id IN (${placeholders})
      FOR UPDATE
    `, seatIds);

    const conflicting = [];
    const now = Date.now();
    for (const row of checkResult.rows) {
      const isHeldValid = row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at).getTime() > now;
      if (row.status === 'booked' || isHeldValid) {
        conflicting.push(row.id);
      }
    }

    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // All good, create hold
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
      WHERE id IN (${updatePlaceholders})
    `, [...seatIds, holdId, expiresAt]);

    await db.exec('COMMIT');

    // Broadcast
    broadcastUpdate(seatIds, 'held');

    res.json({
      holdId,
      seatIds,
      ttlSeconds: HOLD_TTL_SECONDS,
      expiresAt
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm - idempotent
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await expireStaleHolds(true);

  try {
    await db.exec('BEGIN');

    // Find seats for this hold
    const holdResult = await db.query(`
      SELECT id, status, hold_expires_at, booked_by FROM seats 
      WHERE hold_id = $1
      FOR UPDATE
    `, [holdId]);

    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const now = Date.now();
    const expired = holdResult.rows.some(row => 
      row.status !== 'held' || !row.hold_expires_at || new Date(row.hold_expires_at).getTime() < now
    );

    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired or invalid' });
    }

    // Check if already booked (idempotency)
    const alreadyBooked = holdResult.rows.every(row => row.status === 'booked');
    if (alreadyBooked) {
      await db.exec('COMMIT');
      return res.json({ success: true, message: 'Already confirmed', seatIds: holdResult.rows.map(r => r.id) });
    }

    // Book them
    const seatIds = holdResult.rows.map(r => r.id);
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $2
    `, [sessionId, holdId]);

    await db.exec('COMMIT');

    broadcastUpdate(seatIds, 'booked');

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

// DELETE /api/holds/:holdId - release early
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
      broadcastUpdate(released, 'released');
    }

    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release' });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);