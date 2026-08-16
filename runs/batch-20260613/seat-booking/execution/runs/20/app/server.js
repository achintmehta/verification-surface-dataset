import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

// SSE clients
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
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (res.rows[0].count == 0) {
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

// Expiry sweep
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
    broadcast({ type: 'seats_updated', seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
  }
}

setInterval(sweepExpiredHolds, 1000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number`);
  const now = Date.now();
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
  if (!seatIds || !seatIds.length || !sessionId) {
    return res.status(400).json({ error: 'Missing seatIds or sessionId' });
  }

  await sweepExpiredHolds();

  const holdId = `hold_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = Date.now() + 60000; // 60 seconds TTL

  try {
    await db.exec('BEGIN');
    
    // Check availability
    const checkPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${checkPlaceholders}) FOR UPDATE`,
      seatIds
    );

    const now = Date.now();
    const unavailable = checkRes.rows.filter(r => r.status !== 'available' && !(r.status === 'held' && r.hold_expires_at <= now));
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      const missing = seatIds.filter(id => !checkRes.rows.find(r => r.id === id));
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: [...unavailable.map(r => r.id), ...missing]
      });
    }

    // Update seats
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.exec('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ holdId, expiresAt, seats: seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  await sweepExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, seats: bookedRes.rows.map(r => r.id) });
    }

    const holdRes = await db.query(
      `SELECT id, hold_expires_at FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    const now = Date.now();
    if (holdRes.rows.length === 0 || holdRes.rows.some(r => r.hold_expires_at <= now)) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const seatIds = holdRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.exec('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'booked' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ success: true, seats: seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
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
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.exec('COMMIT');

      const updatedSeats = seatIds.map(id => ({ id, status: 'available' }));
      broadcast({ type: 'seats_updated', seats: updatedSeats });
    } else {
      await db.exec('ROLLBACK');
    }
    res.json({ success: true });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { id: Date.now(), res };
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
