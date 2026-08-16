import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

const HOLD_TTL_SECONDS = 60;

// SSE Clients
let clients = [];

function broadcast(data) {
  clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id VARCHAR(10) PRIMARY KEY,
      row_label VARCHAR(2),
      seat_number INT,
      status VARCHAR(20) DEFAULT 'available',
      hold_id VARCHAR(36),
      hold_expires_at TIMESTAMPTZ,
      booked_by VARCHAR(36)
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM seats`);
  if (parseInt(res.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (let r of rows) {
      for (let s = 1; s <= seatsPerRow; s++) {
        const id = `${r}${s}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number) VALUES ($1, $2, $3)`,
          [id, r, s]
        );
      }
    }
  }
}

// Sweep expired holds
async function sweepExpiredHolds() {
  const res = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at <= NOW()
    RETURNING id, status
  `);
  if (res.rows.length > 0) {
    broadcast({ type: 'seats_updated', seats: res.rows });
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  const now = new Date();
  const seats = result.rows.map(s => {
    if (s.status === 'held' && s.hold_expires_at && new Date(s.hold_expires_at) <= now) {
      return { ...s, status: 'available', hold_id: null, hold_expires_at: null };
    }
    return s;
  });
  res.json(seats);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }

  await sweepExpiredHolds();

  try {
    await db.query('BEGIN');
    
    // Lock the requested seats
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = checkRes.rows.filter(s => {
      if (s.status === 'available') return false;
      if (s.status === 'held' && new Date(s.hold_expires_at) <= new Date()) return false;
      return true;
    });
    if (unavailable.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: unavailable.map(s => s.id) 
      });
    }

    if (checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Some seats do not exist' });
    }

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${updatePlaceholders}) 
       RETURNING id, status, hold_id, hold_expires_at`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });

    res.json({ holdId, expiresAt, seats: updateRes.rows });
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

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(
      `SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seats: bookedRes.rows });
    }

    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const expired = checkRes.rows.some(s => new Date(s.hold_expires_at) <= new Date());
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $2, hold_expires_at = NULL 
       WHERE hold_id = $1 
       RETURNING id, status`,
      [holdId, sessionId || 'unknown']
    );

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });

    res.json({ success: true, seats: updateRes.rows });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, status`,
      [holdId]
    );

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

  const client = { id: uuidv4(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
