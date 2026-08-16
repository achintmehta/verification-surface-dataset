import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../pglite-data');
const db = new PGlite(dbPath);

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
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
      held_by TEXT,
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

async function sweepExpiredHolds() {
  const now = Date.now();
  try {
    const sweepRes = await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL WHERE status = 'held' AND hold_expires_at <= $1 RETURNING id`,
      [now]
    );
    if (sweepRes.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: sweepRes.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (e) {
    console.error('Sweep error', e);
  }
}

setInterval(sweepExpiredHolds, 5000);

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
  const seatsRes = await db.query(`SELECT id, row_label, seat_number, status FROM seats ORDER BY row_label, seat_number`);
  res.json(seatsRes.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !seatIds.length || !sessionId) return res.status(400).json({ error: 'Invalid request' });

  const now = Date.now();
  const expiresAt = now + 60000; // 60 seconds TTL
  const holdId = uuidv4();

  await sweepExpiredHolds();

  try {
    await db.transaction(async (tx) => {
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkRes = await tx.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
        seatIds
      );

      const unavailable = checkRes.rows.filter(r => r.status === 'booked' || (r.status === 'held' && r.hold_expires_at > now));
      if (unavailable.length > 0) {
        throw { status: 409, conflictingSeats: unavailable.map(r => r.id) };
      }

      if (checkRes.rows.length !== seatIds.length) {
        throw { status: 400, error: 'Some seats do not exist' };
      }

      const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(',');
      await tx.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2, held_by = $3 WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, sessionId, ...seatIds]
      );
    });

    broadcast({ type: 'seats_updated', seats: seatIds.map(id => ({ id, status: 'held' })) });
    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    console.error(err);
    if (err.status === 409) {
      return res.status(409).json({ conflictingSeats: err.conflictingSeats });
    }
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  const now = Date.now();

  await sweepExpiredHolds();

  try {
    let confirmedSeats = [];
    await db.transaction(async (tx) => {
      const bookedRes = await tx.query(
        `SELECT id, booked_by FROM seats WHERE status = 'booked' AND hold_id = $1`,
        [holdId]
      );
      if (bookedRes.rows.length > 0) {
        if (bookedRes.rows[0].booked_by !== sessionId) {
          throw { status: 403, error: 'Hold was booked by another session' };
        }
        confirmedSeats = bookedRes.rows.map(r => r.id);
        return;
      }

      const holdRes = await tx.query(
        `SELECT id, hold_expires_at, held_by FROM seats WHERE status = 'held' AND hold_id = $1 FOR UPDATE`,
        [holdId]
      );

      if (holdRes.rows.length === 0 || holdRes.rows[0].hold_expires_at <= now) {
        throw { status: 400, error: 'Hold expired or invalid' };
      }
      if (holdRes.rows[0].held_by !== sessionId) {
        throw { status: 403, error: 'Hold belongs to another session' };
      }

      confirmedSeats = holdRes.rows.map(r => r.id);

      await tx.query(
        `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
        [sessionId, holdId]
      );
    });

    if (confirmedSeats.length > 0) {
      broadcast({ type: 'seats_updated', seats: confirmedSeats.map(id => ({ id, status: 'booked' })) });
    }
    res.json({ success: true, seats: confirmedSeats });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    let releasedSeats = [];
    await db.transaction(async (tx) => {
      const holdRes = await tx.query(
        `SELECT id FROM seats WHERE status = 'held' AND hold_id = $1 FOR UPDATE`,
        [holdId]
      );
      if (holdRes.rows.length > 0) {
        releasedSeats = holdRes.rows.map(r => r.id);
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL WHERE hold_id = $1`,
          [holdId]
        );
      }
    });
    if (releasedSeats.length > 0) {
      broadcast({ type: 'seats_updated', seats: releasedSeats.map(id => ({ id, status: 'available' })) });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Backend listening on port 3000');
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});