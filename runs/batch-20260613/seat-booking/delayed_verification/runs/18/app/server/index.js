import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { PGlite } from '@electric-sql/pglite';

const app = express();
app.use(cors());
app.use(express.json());

import fs from 'fs';

const dbPath = './db_data';
if (fs.existsSync(`${dbPath}/postmaster.pid`)) {
  fs.unlinkSync(`${dbPath}/postmaster.pid`);
}

const db = new PGlite(dbPath);

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id VARCHAR PRIMARY KEY,
      row_label VARCHAR NOT NULL,
      seat_number INT NOT NULL,
      status VARCHAR NOT NULL,
      hold_id VARCHAR,
      hold_expires_at BIGINT,
      booked_by VARCHAR
    );
  `);

  const res = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(res.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (const row of rows) {
      for (let i = 1; i <= seatsPerRow; i++) {
        const id = `${row}${i}`;
        await db.query(`
          INSERT INTO seats (id, row_label, seat_number, status)
          VALUES ($1, $2, $3, 'available')
        `, [id, row, i]);
      }
    }
  }
}

initDb().catch(console.error);

const clients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.res.write(payload);
  }
}

async function sweepExpiredHolds() {
  const now = Date.now();
  try {
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
      WHERE status = 'held' AND hold_expires_at < $1
      RETURNING id
    `, [now]);
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  clients.add(client);

  req.on('close', () => {
    clients.delete(client);
  });
});

app.get('/api/seats', async (req, res) => {
  try {
    await sweepExpiredHolds();
    const result = await db.query('SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number');
    const now = Date.now();
    const rows = result.rows.map(seat => {
      if (seat.status === 'held' && seat.hold_expires_at < now) {
        return { ...seat, status: 'available', hold_id: null, hold_expires_at: null, booked_by: null };
      }
      return seat;
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !seatIds.length || !sessionId) return res.status(400).json({ error: 'Invalid request' });

  const now = Date.now();
  const ttl = 60000; // 60 seconds
  const expiresAt = now + ttl;
  const holdId = uuidv4();

  try {
    await db.query('BEGIN');
    
    const sortedSeatIds = [...seatIds].sort();
    const placeholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(`
      SELECT id, status, hold_expires_at 
      FROM seats 
      WHERE id IN (${placeholders})
      ORDER BY id
      FOR UPDATE
    `, sortedSeatIds);

    const seats = seatsRes.rows;
    if (seats.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Some seats do not exist' });
    }

    const conflicts = [];
    for (const seat of seats) {
      const isAvailable = seat.status === 'available' || (seat.status === 'held' && seat.hold_expires_at < now);
      if (!isAvailable) {
        conflicts.push(seat.id);
      }
    }

    if (conflicts.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Seats not available', conflicts });
    }

    for (const seatId of seatIds) {
      await db.query(`
        UPDATE seats
        SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = $3
        WHERE id = $4
      `, [holdId, expiresAt, sessionId, seatId]);
    }

    await db.query('COMMIT');

    broadcast({
      type: 'seats_updated',
      seats: seatIds.map(id => ({ id, status: 'held' }))
    });

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
  const now = Date.now();

  try {
    await db.query('BEGIN');

    const seatsRes = await db.query(`
      SELECT id, status, hold_id, hold_expires_at, booked_by
      FROM seats
      WHERE hold_id = $1
      ORDER BY id
      FOR UPDATE
    `, [holdId]);

    const seats = seatsRes.rows;

    if (seats.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or already expired/overwritten' });
    }

    const alreadyBooked = seats.every(s => s.status === 'booked' && s.booked_by === sessionId);
    if (alreadyBooked) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seatIds: seats.map(s => s.id) });
    }

    let valid = true;
    for (const seat of seats) {
      if (seat.booked_by !== sessionId) valid = false;
      if (seat.status !== 'held') valid = false;
      if (seat.hold_expires_at < now) valid = false;
    }

    if (!valid) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }

    const seatIds = seats.map(s => s.id);
    for (const seatId of seatIds) {
      await db.query(`
        UPDATE seats
        SET status = 'booked', hold_expires_at = NULL
        WHERE id = $1
      `, [seatId]);
    }

    await db.query('COMMIT');

    broadcast({
      type: 'seats_updated',
      seats: seatIds.map(id => ({ id, status: 'booked' }))
    });

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const sessionId = req.body.sessionId || req.query.sessionId;
  
  try {
    await db.query('BEGIN');
    const seatsRes = await db.query(`
      SELECT id, status, booked_by
      FROM seats
      WHERE hold_id = $1 AND status = 'held'
      ORDER BY id
      FOR UPDATE
    `, [holdId]);

    const seats = seatsRes.rows.filter(s => s.booked_by === sessionId);
    if (seats.length === 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true });
    }

    const seatIds = seats.map(s => s.id);
    for (const seatId of seatIds) {
      await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
        WHERE id = $1
      `, [seatId]);
    }
    await db.query('COMMIT');

    broadcast({
      type: 'seats_updated',
      seats: seatIds.map(id => ({ id, status: 'available' }))
    });

    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await db.close();
  process.exit(0);
});
