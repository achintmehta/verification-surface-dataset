import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

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

async function releaseExpiredHolds() {
  try {
    const now = Date.now();
    const res = await db.query(
      `SELECT id FROM seats WHERE status = 'held' AND hold_expires_at <= $1`,
      [now]
    );
    
    if (res.rows.length > 0) {
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at <= $1`,
        [now]
      );
      
      broadcast({
        type: 'seats_updated',
        seats: res.rows.map(r => ({ id: r.id, status: 'available' }))
      });
    }
  } catch (err) {
    console.error('Error releasing expired holds:', err);
  }
}

setInterval(releaseExpiredHolds, 1000);

app.get('/api/seats', async (req, res) => {
  await releaseExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }

  await releaseExpiredHolds();

  const holdId = Math.random().toString(36).substring(2, 15);
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');

    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = checkRes.rows.filter(r => r.status !== 'available');
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(409).json({
        error: 'Seats unavailable',
        conflicts: unavailable.map(r => r.id)
      });
    }

    // Update seats
    // We need to construct the query carefully since we have dynamic number of seatIds
    // $1 is holdId, $2 is expiresAt, $3... are seatIds
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

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

  await releaseExpiredHolds();

  try {
    await db.query('BEGIN');

    const now = Date.now();
    const checkRes = await db.query(
      `SELECT id, status, hold_id, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const alreadyBooked = checkRes.rows.every(r => r.status === 'booked');
    if (alreadyBooked) {
      await db.query('ROLLBACK');
      return res.json({ success: true, message: 'Already booked' });
    }

    const expired = checkRes.rows.some(r => r.status === 'held' && Number(r.hold_expires_at) <= now);
    if (expired) {
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast({
        type: 'seats_updated',
        seats: checkRes.rows.map(r => ({ id: r.id, status: 'available' }))
      });
      return res.status(400).json({ error: 'Hold expired' });
    }

    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    const updatedSeats = checkRes.rows.map(r => ({ id: r.id, status: 'booked' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ success: true });
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
    const checkRes = await db.query(
      `SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length > 0) {
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast({
        type: 'seats_updated',
        seats: checkRes.rows.map(r => ({ id: r.id, status: 'available' }))
      });
    } else {
      await db.query('ROLLBACK');
    }
    res.json({ success: true });
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

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
  });
});
