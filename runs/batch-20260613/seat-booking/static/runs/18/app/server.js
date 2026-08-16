import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_SECONDS = 60;

// SSE Clients
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
      hold_expires_at TIMESTAMP,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (Number(res.rows[0].count) === 0) {
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

// Helper to sweep expired holds
async function sweepExpiredHolds() {
  try {
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at < now()
      RETURNING *
    `);
    if (res.rows.length > 0) {
      broadcast({ type: 'seat_update', seats: res.rows });
    }
  } catch (err) {
    console.error('Error sweeping expired holds:', err);
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by,
           (hold_expires_at < now()) as is_expired
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  
  const seats = result.rows.map(seat => {
    if (seat.status === 'held' && seat.is_expired) {
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

  try {
    await db.query('BEGIN');

    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at < now() as is_expired FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    if (seatsRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Some seats do not exist' });
    }

    const conflictingSeats = [];
    for (const seat of seatsRes.rows) {
      if (seat.status === 'booked') {
        conflictingSeats.push(seat.id);
      } else if (seat.status === 'held' && !seat.is_expired) {
        conflictingSeats.push(seat.id);
      }
    }

    if (conflictingSeats.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Seats not available', conflictingSeats });
    }

    const holdId = uuidv4();

    const updateRes = await db.query(
      `UPDATE seats
       SET status = 'held', hold_id = $1, hold_expires_at = now() + interval '${HOLD_TTL_SECONDS} seconds'
       WHERE id IN (${placeholders})
       RETURNING *`,
      [holdId, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seat_update', seats: updateRes.rows });

    res.json({ holdId, seats: updateRes.rows });
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

  try {
    await db.query('BEGIN');

    const bookedRes = await db.query(
      `SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seats: bookedRes.rows });
    }

    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at < now() as is_expired FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const expired = seatsRes.rows.some(seat => seat.is_expired);
    if (expired) {
      const releaseRes = await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1 RETURNING *`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast({ type: 'seat_update', seats: releaseRes.rows });
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(
      `UPDATE seats
       SET status = 'booked', booked_by = $2, hold_expires_at = NULL
       WHERE hold_id = $1
       RETURNING *`,
      [holdId, sessionId]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seat_update', seats: updateRes.rows });

    res.json({ success: true, seats: updateRes.rows });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const updateRes = await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING *`,
      [holdId]
    );

    if (updateRes.rows.length > 0) {
      broadcast({ type: 'seat_update', seats: updateRes.rows });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
  });
});
