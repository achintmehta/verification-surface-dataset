import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

let clients = [];

function broadcast(data) {
  clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (Number(res.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const r of rows) {
      for (let i = 1; i <= 10; i++) {
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
  try {
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= NOW()
      RETURNING *
    `);
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

setInterval(sweepExpiredHolds, 1000);

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

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  const holdId = crypto.randomUUID();
  const ttlSeconds = 60;

  try {
    await db.exec('BEGIN');
    
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = seatsRes.rows.filter(s => s.status !== 'available');
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: unavailable.map(s => s.id) 
      });
    }

    if (seatsRes.rows.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Invalid seat IDs' });
    }

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = NOW() + INTERVAL '${ttlSeconds} seconds'
       WHERE id IN (${updatePlaceholders})
       RETURNING *`,
      [holdId, ...seatIds]
    );

    await db.exec('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });
    
    res.json({ 
      holdId, 
      expiresAt: updateRes.rows[0].hold_expires_at,
      seats: updateRes.rows 
    });
  } catch (err) {
    console.error(err);
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  await sweepExpiredHolds();

  try {
    await db.exec('BEGIN');

    const bookedRes = await db.query(
      `SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, seats: bookedRes.rows });
    }

    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const expiredRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND hold_expires_at <= NOW()`,
      [holdId]
    );
    if (expiredRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $2
       WHERE hold_id = $1
       RETURNING *`,
      [holdId, sessionId]
    );

    await db.exec('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });
    
    res.json({ success: true, seats: updateRes.rows });
  } catch (err) {
    console.error(err);
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.exec('BEGIN');
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING *`,
      [holdId]
    );
    await db.exec('COMMIT');

    if (updateRes.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: updateRes.rows });
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
