import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
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

// Sweep expired holds
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
    const releasedSeats = res.rows.map(r => r.id);
    broadcast('seats_updated', { seats: releasedSeats, status: 'available' });
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
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  const holdId = crypto.randomUUID();
  const expiresAt = Date.now() + HOLD_TTL_MS;

  try {
    await db.transaction(async (tx) => {
      // Check availability
      const selectPlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkRes = await tx.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${selectPlaceholders}) FOR UPDATE`,
        seatIds
      );

      const now = Date.now();
      const unavailable = checkRes.rows.filter(r => {
        if (r.status === 'available') return false;
        if (r.status === 'held' && r.hold_expires_at <= now) return false;
        return true;
      }).map(r => r.id);

      if (unavailable.length > 0) {
        throw { status: 409, body: { error: 'Seats unavailable', conflictingSeatIds: unavailable } };
      }

      if (checkRes.rows.length !== seatIds.length) {
        throw { status: 400, body: { error: 'Some seats do not exist' } };
      }

      // Update seats
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
      await tx.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, ...seatIds]
      );
    });

    broadcast('seats_updated', { seats: seatIds, status: 'held' });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
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
    let seatIds = [];
    let alreadyBooked = false;

    await db.transaction(async (tx) => {
      // Check if already booked by this holdId (idempotency)
      const bookedRes = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
        [holdId]
      );
      if (bookedRes.rows.length > 0) {
        alreadyBooked = true;
        seatIds = bookedRes.rows.map(r => r.id);
        return;
      }

      const holdRes = await tx.query(
        `SELECT id, hold_expires_at FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
        [holdId]
      );

      const now = Date.now();
      if (holdRes.rows.length === 0 || holdRes.rows[0].hold_expires_at <= now) {
        throw { status: 400, body: { error: 'Hold expired or invalid' } };
      }

      seatIds = holdRes.rows.map(r => r.id);

      await tx.query(
        `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
        [sessionId, holdId]
      );
    });

    if (alreadyBooked) {
      return res.json({ success: true, seatIds });
    }

    broadcast('seats_updated', { seats: seatIds, status: 'booked' });

    res.json({ success: true, seatIds });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body);
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    let seatIds = [];
    await db.transaction(async (tx) => {
      const holdRes = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
        [holdId]
      );

      if (holdRes.rows.length > 0) {
        seatIds = holdRes.rows.map(r => r.id);
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
          [holdId]
        );
      }
    });

    if (seatIds.length > 0) {
      broadcast('seats_updated', { seats: seatIds, status: 'available' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
