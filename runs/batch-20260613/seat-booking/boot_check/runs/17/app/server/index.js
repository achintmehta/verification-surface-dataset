const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

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
      status TEXT NOT NULL,
      hold_id TEXT,
      hold_expires_at BIGINT,
      held_by TEXT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (Number(res.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (let r of rows) {
      for (let i = 1; i <= seatsPerRow; i++) {
        const id = `${r}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [id, r, i]
        );
      }
    }
  }
}

async function sweepExpiredHolds() {
  const now = Date.now();
  try {
    const res = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL 
       WHERE status = 'held' AND hold_expires_at <= $1 
       RETURNING id`,
      [now]
    );
    if (res.rows.length > 0) {
      const releasedSeats = res.rows.map(r => r.id);
      broadcast('seats_updated', { seats: releasedSeats, status: 'available' });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

setInterval(sweepExpiredHolds, 1000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0) {
    return res.status(400).json({ error: 'No seats requested' });
  }

  await sweepExpiredHolds();

  const holdId = uuidv4();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');

    const sortedSeatIds = [...seatIds].sort();
    const placeholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(', ');
    const checkRes = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      sortedSeatIds
    );

    const unavailable = checkRes.rows.filter(r => r.status !== 'available');
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      const conflicting = unavailable.map(r => r.id);
      const foundIds = checkRes.rows.map(r => r.id);
      const missing = seatIds.filter(id => !foundIds.includes(id));
      return res.status(409).json({ error: 'Seats unavailable', conflicting: [...conflicting, ...missing] });
    }

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(', ');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2, held_by = $3 
       WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, sessionId, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'held' });

    res.json({ holdId, expiresAt, seats: seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await sweepExpiredHolds();

  try {
    await db.query('BEGIN');

    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seats: bookedRes.rows.map(r => r.id) });
    }

    const heldRes = await db.query(
      `SELECT id, status, hold_expires_at, held_by FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE`,
      [holdId]
    );

    if (heldRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    if (heldRes.rows.some(r => r.held_by !== sessionId)) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to confirm this hold' });
    }

    const now = Date.now();
    const expired = heldRes.rows.some(r => r.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = heldRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1 
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'booked' });

    res.json({ success: true, seats: seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.query('BEGIN');
    const heldRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY id FOR UPDATE`,
      [holdId]
    );

    if (heldRes.rows.length > 0) {
      const seatIds = heldRes.rows.map(r => r.id);
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast('seats_updated', { seats: seatIds, status: 'available' });
      res.json({ success: true });
    } else {
      await db.query('ROLLBACK');
      res.json({ success: true });
    }
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c !== client);
  });
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
