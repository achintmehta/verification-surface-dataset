const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM seats`);
  if (res.rows[0].count === '0' || res.rows[0].count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rows) {
      for (let i = 1; i <= 10; i++) {
        const id = `${row}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [id, row, i]
        );
      }
    }
  }
}

async function sweepExpiredHolds() {
  const now = Date.now();
  const res = await db.query(
    `UPDATE seats 
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
     WHERE status = 'held' AND hold_expires_at <= $1 
     RETURNING id`,
    [now]
  );
  if (res.rows.length > 0) {
    const releasedIds = res.rows.map(r => r.id);
    broadcast('seats_updated', { seats: releasedIds, status: 'available' });
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  const now = Date.now();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  const seats = result.rows.map(r => {
    if (r.status === 'held' && r.hold_expires_at <= now) {
      return { ...r, status: 'available', hold_id: null, hold_expires_at: null };
    }
    return r;
  });
  res.json(seats);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }

  const holdId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + HOLD_TTL_MS;

  try {
    await db.exec('BEGIN');
    
    // Lock the requested seats
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = checkRes.rows.filter(r => r.status === 'booked' || (r.status === 'held' && r.hold_expires_at > now));
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      const conflicting = unavailable.map(r => r.id);
      // Also find missing seats
      const foundIds = new Set(checkRes.rows.map(r => r.id));
      const missing = seatIds.filter(id => !foundIds.has(id));
      return res.status(409).json({ error: 'Seats unavailable', conflicting: [...conflicting, ...missing] });
    }

    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${placeholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.exec('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'held' });
    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  const now = Date.now();

  try {
    await db.exec('BEGIN');

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, seatIds: bookedRes.rows.map(r => r.id) });
    }

    const holdRes = await db.query(
      `SELECT id, hold_expires_at FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length === 0 || holdRes.rows[0].hold_expires_at <= now) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const seatIds = holdRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1, hold_expires_at = NULL 
       WHERE hold_id = $2`,
      [sessionId || 'unknown', holdId]
    );

    await db.exec('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'booked' });
    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.exec('BEGIN');
    const holdRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length > 0) {
      const seatIds = holdRes.rows.map(r => r.id);
      await db.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
         WHERE hold_id = $1`,
        [holdId]
      );
      await db.exec('COMMIT');
      broadcast('seats_updated', { seats: seatIds, status: 'available' });
    } else {
      await db.exec('ROLLBACK');
    }
    res.json({ success: true });
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { id: crypto.randomUUID(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
});
