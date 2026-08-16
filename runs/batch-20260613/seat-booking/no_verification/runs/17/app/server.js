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

const db = new PGlite(path.join(__dirname, 'db'));

// SSE clients
let clients = [];

function broadcast(data) {
  clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// Initialize DB
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT,
      seat_number INTEGER,
      status TEXT, -- 'available', 'held', 'booked'
      hold_id TEXT,
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (Number(res.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rows) {
      for (let i = 1; i <= 10; i++) {
        const id = `${row}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)`,
          [id, row, i, 'available']
        );
      }
    }
  }
}

// Sweep expired holds
async function sweepExpiredHolds() {
  try {
    const now = Date.now();
    const res = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE status = 'held' AND hold_expires_at <= $1 
       RETURNING id`,
      [now]
    );
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (err) {
    console.error('Error sweeping expired holds:', err);
  }
}

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

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  
  const now = Date.now();
  const seats = result.rows.map(r => {
    if (r.status === 'held' && Number(r.hold_expires_at) <= now) {
      return { ...r, status: 'available', hold_id: null, hold_expires_at: null };
    }
    return r;
  });
  
  res.json(seats);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !seatIds.length || !sessionId) {
    return res.status(400).json({ error: 'Missing seatIds or sessionId' });
  }

  await sweepExpiredHolds();

  const holdId = uuidv4();
  const ttl = 60000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');
    
    // Check availability
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const now = Date.now();
    const unavailable = checkRes.rows.filter(r => {
      if (r.status === 'available') return false;
      if (r.status === 'held' && Number(r.hold_expires_at) <= now) return false;
      return true;
    });

    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: unavailable.map(r => r.id) 
      });
    }

    // Update seats
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${placeholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast({ 
      type: 'seats_updated', 
      seats: seatIds.map(id => ({ id, status: 'held' })) 
    });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await db.query('BEGIN');

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seatIds: bookedRes.rows.map(r => r.id) });
    }

    const now = Date.now();
    const holdRes = await db.query(
      `SELECT id, hold_expires_at FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    // Check if expired
    if (Number(holdRes.rows[0].hold_expires_at) <= now) {
      const seatIds = holdRes.rows.map(r => r.id);
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast({ type: 'seats_updated', seats: seatIds.map(id => ({ id, status: 'available' })) });
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = holdRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1 
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    broadcast({ 
      type: 'seats_updated', 
      seats: seatIds.map(id => ({ id, status: 'booked' })) 
    });

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.query('BEGIN');
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
      await db.query('COMMIT');

      broadcast({ 
        type: 'seats_updated', 
        seats: seatIds.map(id => ({ id, status: 'available' })) 
      });
    } else {
      await db.query('ROLLBACK');
    }
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  setInterval(sweepExpiredHolds, 1000);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
