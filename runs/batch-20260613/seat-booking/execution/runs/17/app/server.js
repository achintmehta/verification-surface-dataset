const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const path = require('path');

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
      status TEXT NOT NULL, -- 'available', 'held', 'booked'
      hold_id TEXT,
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (res.rows[0].count == 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const r of rows) {
      for (let i = 1; i <= 10; i++) {
        const id = `${r}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)`,
          [id, r, i, 'available']
        );
      }
    }
  }
}

async function sweepExpiredHolds() {
  const now = Date.now();
  try {
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

setInterval(sweepExpiredHolds, 1000);

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
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  await sweepExpiredHolds();
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'No seats provided' });
  }
  seatIds.sort();

  const holdId = uuidv4();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.transaction(async (tx) => {
      const selectPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkRes = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${selectPlaceholders}) FOR UPDATE`,
        seatIds
      );

      const unavailable = checkRes.rows.filter(r => r.status !== 'available');
      if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
        const conflictingIds = unavailable.map(r => r.id);
        const foundIds = checkRes.rows.map(r => r.id);
        const missingIds = seatIds.filter(id => !foundIds.includes(id));
        const err = new Error('Seats unavailable');
        err.status = 409;
        err.conflictingSeatIds = [...conflictingIds, ...missingIds];
        throw err;
      }

      const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
      await tx.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, ...seatIds]
      );
    });

    const updatedSeats = seatIds.map(id => ({ id, status: 'held', hold_id: holdId, hold_expires_at: expiresAt }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ holdId, expiresAt, seats: seatIds });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, conflictingSeatIds: err.conflictingSeatIds });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  await sweepExpiredHolds();
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    let bookedSeats = [];
    await db.transaction(async (tx) => {
      const alreadyBookedRes = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY id FOR UPDATE`,
        [holdId]
      );
      
      if (alreadyBookedRes.rows.length > 0) {
        bookedSeats = alreadyBookedRes.rows.map(r => r.id);
        return;
      }

      const checkRes = await tx.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE`,
        [holdId]
      );

      if (checkRes.rows.length === 0) {
        const err = new Error('Hold not found or expired');
        err.status = 404;
        throw err;
      }

      const now = Date.now();
      const expired = checkRes.rows.some(r => r.hold_expires_at <= now);
      if (expired) {
        const err = new Error('Hold expired');
        err.status = 400;
        throw err;
      }

      const seatIds = checkRes.rows.map(r => r.id);
      await tx.query(
        `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
        [sessionId, holdId]
      );
      bookedSeats = seatIds;
    });

    if (bookedSeats.length > 0) {
      const updatedSeats = bookedSeats.map(id => ({ id, status: 'booked', hold_id: holdId }));
      broadcast({ type: 'seats_updated', seats: updatedSeats });
    }

    res.json({ success: true, seats: bookedSeats });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    let releasedSeats = [];
    await db.transaction(async (tx) => {
      const checkRes = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY id FOR UPDATE`,
        [holdId]
      );
      if (checkRes.rows.length > 0) {
        releasedSeats = checkRes.rows.map(r => r.id);
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
          [holdId]
        );
      }
    });

    if (releasedSeats.length > 0) {
      const updatedSeats = releasedSeats.map(id => ({ id, status: 'available' }));
      broadcast({ type: 'seats_updated', seats: updatedSeats });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
