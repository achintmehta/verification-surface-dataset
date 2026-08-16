import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_SECONDS = 60;

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
      status TEXT NOT NULL, -- 'available', 'held', 'booked'
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
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
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [id, row, i]
        );
      }
    }
  }
}

async function sweepExpiredHolds() {
  try {
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= now()
      RETURNING id
    `);
    if (res.rows.length > 0) {
      const releasedSeats = res.rows.map(r => r.id);
      broadcast('seats_updated', { seats: releasedSeats, status: 'available' });
    }
  } catch (err) {
    console.error('Error sweeping expired holds:', err);
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`
    SELECT 
      id, row_label, seat_number, 
      CASE 
        WHEN status = 'held' AND hold_expires_at <= now() THEN 'available'
        ELSE status 
      END as status,
      CASE 
        WHEN status = 'held' AND hold_expires_at <= now() THEN NULL
        ELSE hold_id 
      END as hold_id,
      CASE 
        WHEN status = 'held' AND hold_expires_at <= now() THEN NULL
        ELSE hold_expires_at 
      END as hold_expires_at,
      booked_by
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  let { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  seatIds = [...new Set(seatIds)];

  await sweepExpiredHolds();

  try {
    await db.exec('BEGIN');
    
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = [];
    for (const s of seatsRes.rows) {
      if (s.status === 'booked') {
        unavailable.push(s.id);
      } else if (s.status === 'held') {
        const expiredRes = await db.query(`SELECT now() >= $1 as expired`, [s.hold_expires_at]);
        if (!expiredRes.rows[0].expired) {
          unavailable.push(s.id);
        }
      }
    }

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeats: unavailable });
    }

    if (seatsRes.rows.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Some seats do not exist' });
    }

    const holdId = uuidv4();

    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = now() + interval '${HOLD_TTL_SECONDS} seconds' WHERE id IN (${placeholders})`,
      [holdId, ...seatIds]
    );

    const expiresRes = await db.query(`SELECT hold_expires_at FROM seats WHERE hold_id = $1 LIMIT 1`, [holdId]);
    const expiresAt = expiresRes.rows[0].hold_expires_at;

    await db.exec('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'held' });

    res.json({ holdId, expiresAt, seatIds });
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
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  try {
    await db.exec('BEGIN');

    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, seatIds: bookedRes.rows.map(r => r.id) });
    }

    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    // Check expiry in DB time
    const expiredRes = await db.query(`SELECT now() >= $1 as expired`, [seatsRes.rows[0].hold_expires_at]);
    if (expiredRes.rows[0].expired) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = seatsRes.rows.map(s => s.id);

    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1, hold_expires_at = NULL WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.exec('COMMIT');

    broadcast('seats_updated', { seats: seatIds, status: 'booked' });

    res.json({ success: true, seatIds });
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

    const seatsRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length > 0) {
      const seatIds = seatsRes.rows.map(s => s.id);
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.exec('COMMIT');
      broadcast('seats_updated', { seats: seatIds, status: 'available' });
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

  const clientId = uuidv4();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on('close', () => {
    clients = clients.filter(client => client.id !== clientId);
  });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
