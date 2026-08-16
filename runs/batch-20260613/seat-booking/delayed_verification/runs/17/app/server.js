import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

let clients = [];

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => client.res.write(message));
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

async function sweepExpiredHolds() {
  try {
    const now = Date.now();
    const res = await db.query(
      `WITH expired AS (
         SELECT id FROM seats WHERE status = 'held' AND hold_expires_at <= $1 ORDER BY id FOR UPDATE
       )
       UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       FROM expired 
       WHERE seats.id = expired.id 
       RETURNING seats.id`,
      [now]
    );
    if (res.rows.length > 0) {
      broadcast('seats_updated', { seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (err) {
    console.error('Error sweeping expired holds:', err);
  }
}

setInterval(sweepExpiredHolds, 5000);

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
  const now = Date.now();
  const seats = result.rows.map(s => {
    if (s.status === 'held' && s.hold_expires_at <= now) {
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

  const holdId = randomUUID();
  const now = Date.now();
  const expiresAt = now + HOLD_TTL_MS;

  try {
    await db.query('BEGIN');
    
    const sortedSeatIds = [...seatIds].sort();
    const selectPlaceholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${selectPlaceholders}) ORDER BY id FOR UPDATE`,
      sortedSeatIds
    );

    const conflicting = [];
    for (const seat of seatsRes.rows) {
      if (seat.status === 'booked') {
        conflicting.push(seat.id);
      } else if (seat.status === 'held' && seat.hold_expires_at > now) {
        conflicting.push(seat.id);
      }
    }

    if (conflicting.length > 0 || seatsRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      // Find missing seats if any
      const foundIds = new Set(seatsRes.rows.map(s => s.id));
      const missing = seatIds.filter(id => !foundIds.has(id));
      return res.status(409).json({ error: 'Seats unavailable', conflicting: [...conflicting, ...missing] });
    }

    const updatePlaceholders = sortedSeatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...sortedSeatIds]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held' }));
    broadcast('seats_updated', { seats: updatedSeats });

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

    const seatsRes = await db.query(
      `SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const alreadyBooked = seatsRes.rows.every(s => s.status === 'booked');
    if (alreadyBooked) {
      const bookedByMe = seatsRes.rows.every(s => s.booked_by === sessionId);
      if (bookedByMe) {
        await db.query('ROLLBACK');
        return res.json({ success: true, seatIds: seatsRes.rows.map(s => s.id) });
      } else {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'Hold already confirmed by another session' });
      }
    }

    const now = Date.now();
    const expired = seatsRes.rows.some(s => s.status === 'held' && s.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = seatsRes.rows.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1, hold_expires_at = NULL WHERE id IN (${placeholders}) AND hold_id = $2`,
      [sessionId, holdId, ...seatIds]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'booked' }));
    broadcast('seats_updated', { seats: updatedSeats });

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
    const seatsRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY id FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length > 0) {
      const seatIds = seatsRes.rows.map(s => s.id);
      const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE id IN (${placeholders}) AND hold_id = $1`,
        [holdId, ...seatIds]
      );
      await db.query('COMMIT');

      const updatedSeats = seatIds.map(id => ({ id, status: 'available' }));
      broadcast('seats_updated', { seats: updatedSeats });
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
    console.log('Server listening on port 3000');
  });
});
