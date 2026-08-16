import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at BIGINT,
      held_by TEXT,
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
          `INSERT INTO seats (id, row_label, seat_number) VALUES ($1, $2, $3)`,
          [id, row, i]
        );
      }
    }
  }
}

const clients = new Set();

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(message);
    } catch (err) {
      clients.delete(client);
    }
  }
}

async function sweepExpiredHolds() {
  const now = Date.now();
  const res = await db.query(
    `UPDATE seats 
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL 
     WHERE status = 'held' AND hold_expires_at <= $1 
     RETURNING id`,
    [now]
  );
  if (res.rows.length > 0) {
    broadcast('seats_updated', res.rows.map(r => ({ id: r.id, status: 'available' })));
  }
}

setInterval(sweepExpiredHolds, 1000);

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

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, held_by, booked_by FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }

  await sweepExpiredHolds();

  const holdId = crypto.randomUUID();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');

    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
    const checkRes = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = checkRes.rows.filter(r => r.status !== 'available');
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      const conflictingIds = unavailable.map(r => r.id);
      const foundIds = new Set(checkRes.rows.map(r => r.id));
      for (const id of seatIds) {
        if (!foundIds.has(id)) conflictingIds.push(id);
      }
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: conflictingIds });
    }

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(', ');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2, held_by = $3 
       WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, sessionId, ...seatIds]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held', hold_id: holdId, hold_expires_at: expiresAt }));
    broadcast('seats_updated', updatedSeats);

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

  await sweepExpiredHolds();

  try {
    await db.query('BEGIN');

    const checkRes = await db.query(
      `SELECT id, status, hold_id, hold_expires_at, held_by, booked_by FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const isOwner = checkRes.rows.every(r => r.held_by === sessionId || r.booked_by === sessionId);
    if (!isOwner) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Not the hold owner' });
    }

    const alreadyBooked = checkRes.rows.every(r => r.status === 'booked');
    if (alreadyBooked) {
      await db.query('ROLLBACK');
      return res.json({ success: true, message: 'Already booked', seatIds: checkRes.rows.map(r => r.id) });
    }

    const now = Date.now();
    const isExpired = checkRes.rows.some(r => r.status === 'held' && r.hold_expires_at <= now);
    if (isExpired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const canBook = checkRes.rows.every(r => r.status === 'held');
    if (!canBook) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid hold state' });
    }

    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    const updatedSeats = checkRes.rows.map(r => ({ id: r.id, status: 'booked' }));
    broadcast('seats_updated', updatedSeats);

    res.json({ success: true, seatIds: checkRes.rows.map(r => r.id) });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await sweepExpiredHolds();

  try {
    await db.query('BEGIN');

    const checkRes = await db.query(
      `SELECT id, status, held_by FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length > 0) {
      const isOwner = checkRes.rows.every(r => r.held_by === sessionId);
      if (!isOwner) {
        await db.query('ROLLBACK');
        return res.status(403).json({ error: 'Not the hold owner' });
      }

      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await db.query('COMMIT');

      const updatedSeats = checkRes.rows.map(r => ({ id: r.id, status: 'available' }));
      broadcast('seats_updated', updatedSeats);
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

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Backend listening on port 3000');
  });
}).catch(console.error);
