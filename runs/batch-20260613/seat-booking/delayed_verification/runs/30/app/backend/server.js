import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

app.use(cors());
app.use(express.json());

// Initialize PGLite with file persistence
const db = new PGlite(join(__dirname, 'pgdata'));

let sseClients = new Set();

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
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

  // Seed seats if not exists (5 rows x 10 seats)
  const { rows: countRows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(countRows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    for (const row of rows) {
      for (let seat = 1; seat <= 10; seat++) {
        const id = `${row}${seat}`;
        values.push(`('${id}', '${row}', ${seat}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(', ')}`);
  }
}

async function releaseExpiredHolds() {
  const { rows } = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < NOW()
    RETURNING id
  `);
  
  if (rows.length > 0) {
    const releasedSeats = rows.map(r => r.id);
    broadcast('seats-released', { seatIds: releasedSeats });
    return releasedSeats;
  }
  return [];
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  const { rows } = await db.query(`
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
  return rows.map(row => ({
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status: row.effective_status,
    holdId: row.hold_id,
    expiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  }));
}

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    await releaseExpiredHolds();

    // Use transaction for atomicity
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: unavailable } = await db.query(`
      SELECT id FROM seats 
      WHERE id = ANY(ARRAY[${placeholders}]) 
      AND (status != 'available' OR (status = 'held' AND hold_expires_at > NOW()))
    `, seatIds);

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflictingSeatIds: unavailable.map(r => r.id) 
      });
    }

    // Create hold
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Update seats to held using SQL interval for timestamp
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = NOW() + INTERVAL '2 minutes' 
      WHERE id = ANY(ARRAY[${updatePlaceholders}])
    `, [holdId, ...seatIds]);

    await db.exec('COMMIT');

    // Fetch expires_at
    const { rows: expRows } = await db.query('SELECT hold_expires_at FROM seats WHERE hold_id = $1 LIMIT 1', [holdId]);
    const expiresAt = expRows[0]?.hold_expires_at;

    broadcast('seats-held', { seatIds, holdId, sessionId, expiresAt });

    res.json({ 
      holdId, 
      expiresAt, 
      seatIds 
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await releaseExpiredHolds();

    await db.exec('BEGIN');

    // Check hold validity and get seats
    const { rows: holdSeats } = await db.query(`
      SELECT id, status, hold_id, hold_expires_at, booked_by 
      FROM seats 
      WHERE hold_id = $1
    `, [holdId]);

    if (holdSeats.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    // Check if already booked (idempotency)
    const alreadyBooked = holdSeats.every(s => s.status === 'booked' && s.booked_by === sessionId);
    if (alreadyBooked) {
      await db.exec('COMMIT');
      return res.json({ success: true, message: 'Already confirmed', seatIds: holdSeats.map(s => s.id) });
    }

    // Validate all are held by this hold and not expired
    const now = new Date();
    const valid = holdSeats.every(s => 
      s.status === 'held' && 
      s.hold_id === holdId && 
      new Date(s.hold_expires_at) > now
    );

    if (!valid) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }

    // Book them
    const seatIds = holdSeats.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_expires_at = NULL 
      WHERE hold_id = $2 AND id = ANY(ARRAY[${placeholders}])
    `, [sessionId, holdId, ...seatIds]);

    await db.exec('COMMIT');

    broadcast('seats-booked', { seatIds, holdId, sessionId });

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await releaseExpiredHolds();

    const { rows } = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id
    `, [holdId]);

    if (rows.length > 0) {
      const released = rows.map(r => r.id);
      broadcast('seats-released', { seatIds: released, holdId });
    }

    res.json({ success: true, releasedSeats: rows.map(r => r.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

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

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    const released = await releaseExpiredHolds();
    if (released.length > 0) {
      console.log('Periodic release:', released);
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);