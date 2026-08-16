import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_SECONDS = 60;

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
      hold_expires_at TIMESTAMP,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (parseInt(res.rows[0].count, 10) === 0) {
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
  try {
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= now()
      RETURNING id, status, hold_expires_at
    `);
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds: rawSeatIds, sessionId } = req.body;
  if (!rawSeatIds || !Array.isArray(rawSeatIds) || rawSeatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }
  const seatIds = [...new Set(rawSeatIds)];

  await sweepExpiredHolds();

  const holdId = crypto.randomUUID();
  
  try {
    await db.exec('BEGIN');
    
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(`
      SELECT id, status, hold_expires_at, (hold_expires_at <= now()) as is_expired 
      FROM seats 
      WHERE id IN (${placeholders})
      FOR UPDATE
    `, seatIds);

    const unavailable = checkRes.rows.filter(s => s.status === 'booked' || (s.status === 'held' && !s.is_expired));
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      const conflictingIds = unavailable.map(s => s.id);
      const foundIds = new Set(checkRes.rows.map(s => s.id));
      for (const id of seatIds) {
        if (!foundIds.has(id) && !conflictingIds.includes(id)) {
          conflictingIds.push(id);
        }
      }
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: conflictingIds });
    }

    const updateRes = await db.query(`
      UPDATE seats
      SET status = 'held', hold_id = $1, hold_expires_at = now() + interval '${HOLD_TTL_SECONDS} seconds'
      WHERE id IN (${placeholders})
      RETURNING id, status, hold_expires_at
    `, [holdId, ...seatIds]);

    await db.exec('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });

    res.json({ holdId, expiresAt: updateRes.rows[0].hold_expires_at, seats: updateRes.rows });
  } catch (err) {
    console.error(err);
    await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await db.exec('BEGIN');

    const bookedRes = await db.query(`
      SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'booked'
    `, [holdId]);

    if (bookedRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, message: 'Already booked', seats: bookedRes.rows });
    }

    const checkRes = await db.query(`
      SELECT id, status, hold_expires_at, (hold_expires_at <= now()) as is_expired 
      FROM seats 
      WHERE hold_id = $1
      FOR UPDATE
    `, [holdId]);

    if (checkRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const expired = checkRes.rows.some(s => s.status !== 'held' || s.is_expired);
    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(`
      UPDATE seats
      SET status = 'booked', booked_by = $2
      WHERE hold_id = $1
      RETURNING id, status, hold_expires_at
    `, [holdId, sessionId || 'unknown']);

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
    const updateRes = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id, status, hold_expires_at
    `, [holdId]);

    if (updateRes.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: updateRes.rows });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
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

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Backend listening on port 3000');
  });
});
