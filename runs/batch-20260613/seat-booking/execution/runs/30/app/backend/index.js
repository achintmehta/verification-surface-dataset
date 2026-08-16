const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// PGLite instance with file persistence
const db = new PGlite({ dataDir: './pgdata' });

let clients = new Set(); // SSE clients

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
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0].count;
  if (count === 0) {
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

function broadcastUpdate() {
  const data = JSON.stringify({ type: 'seat-update', timestamp: Date.now() });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
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
    console.log(`Released ${result.rows.length} expired seats`);
    broadcastUpdate();
  }
  return result.rows.length;
}

async function getEffectiveSeats() {
  await releaseExpiredHolds();
  const res = await db.query(`
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
  return res.rows.map(row => ({
    ...row,
    status: row.status // already effective
  }));
}

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getEffectiveSeats();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const holdId = 'hold_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const ttlSeconds = 60; // 1 minute TTL
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  try {
    await db.exec('BEGIN');
    
    // First, release any expired
    await releaseExpiredHolds();

    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id FROM seats WHERE id IN (${placeholders}) AND status != 'available'`,
      seatIds
    );

    if (checkRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      const conflicting = checkRes.rows.map(r => r.id);
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // Atomically acquire all
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
       WHERE id IN (${updatePlaceholders})`,
      [...seatIds, holdId, expiresAt]
    );

    await db.exec('COMMIT');

    broadcastUpdate();

    res.json({
      id: holdId,
      seatIds,
      sessionId,
      expiresAt,
      ttlSeconds
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    // Idempotency check outside transaction
    const alreadyBooked = await db.query(
      `SELECT id FROM seats WHERE booked_by = $1 AND status = 'booked' LIMIT 1`,
      [holdId]
    );
    if (alreadyBooked.rows.length > 0) {
      return res.json({ success: true, message: 'Already confirmed' });
    }

    await db.exec('BEGIN');

    await releaseExpiredHolds();

    // Check if hold exists and valid
    const holdCheck = await db.query(
      `SELECT hold_id FROM seats WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW() LIMIT 1`,
      [holdId]
    );

    if (holdCheck.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found, expired, or invalid' });
    }

    // Confirm: book the seats
    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = hold_id, hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'`,
      [holdId]
    );

    await db.exec('COMMIT');
    broadcastUpdate();
    res.json({ success: true, message: 'Seats booked successfully' });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Confirm failed' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1`,
      [holdId]
    );

    if (result.rowCount > 0) {
      broadcastUpdate();
    }
    res.json({ success: true, released: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Release failed' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  await releaseExpiredHolds();
}, 10000); // every 10s

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
