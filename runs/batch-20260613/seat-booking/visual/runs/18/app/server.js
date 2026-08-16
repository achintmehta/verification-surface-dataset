import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pgdata');

// SSE clients
let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

// Initialize DB
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
    const releasedIds = res.rows.map(r => r.id);
    broadcast('seats_updated', { seats: releasedIds, status: 'available' });
  }
}

setInterval(sweepExpiredHolds, 1000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  const now = Date.now();
  const seats = result.rows.map(seat => {
    if (seat.status === 'held' && seat.hold_expires_at <= now) {
      return { ...seat, status: 'available', hold_id: null, hold_expires_at: null };
    }
    return seat;
  });
  res.json(seats);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  const holdId = randomUUID();
  const ttl = 60000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');
    
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    if (checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Some seats do not exist' });
    }

    const now = Date.now();
    const unavailable = checkRes.rows.filter(r => r.status === 'booked' || (r.status === 'held' && r.hold_expires_at > now));
    
    if (unavailable.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Seats unavailable', 
        conflicts: unavailable.map(r => r.id) 
      });
    }

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'held' });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  try {
    await db.query('BEGIN');

    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const alreadyBooked = checkRes.rows.every(r => r.status === 'booked');
    if (alreadyBooked) {
      await db.query('ROLLBACK');
      return res.json({ success: true, message: 'Already booked', seatIds: checkRes.rows.map(r => r.id) });
    }

    const now = Date.now();
    const expired = checkRes.rows.some(r => r.status === 'held' && r.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = checkRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1, hold_expires_at = NULL 
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'booked' });

    res.json({ success: true, seatIds });
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
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length > 0) {
      const seatIds = checkRes.rows.map(r => r.id);
      await db.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
         WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast('seats_updated', { seats: seatIds, status: 'available' });
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

  const client = { id: randomUUID(), res };
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
