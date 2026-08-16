import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pglite-data'));

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
      status TEXT NOT NULL,
      hold_id TEXT,
      hold_expires_at TIMESTAMP,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (res.rows[0].count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (let r of rows) {
      for (let i = 1; i <= seatsPerRow; i++) {
        const id = `${r}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)`,
          [id, r, i, 'available']
        );
      }
    }
  }
}

// Helper to expire holds
async function expireHolds() {
  const res = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at <= NOW()
    RETURNING id, status
  `);
  if (res.rows.length > 0) {
    broadcast({ type: 'seats_updated', seats: res.rows });
  }
}

// Run expiry periodically
setInterval(expireHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await expireHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await expireHolds();

  const holdId = uuidv4();
  
  try {
    await db.exec('BEGIN');
    
    // Lock the requested seats in a consistent order to prevent deadlocks
    const sortedSeatIds = [...seatIds].sort();
    const placeholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at, hold_expires_at <= NOW() as is_expired FROM seats WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      sortedSeatIds
    );

    if (seatsRes.rows.length !== new Set(seatIds).size) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Some seats do not exist' });
    }

    const unavailable = [];
    for (const seat of seatsRes.rows) {
      if (seat.status === 'booked') {
        unavailable.push(seat.id);
      } else if (seat.status === 'held') {
        if (!seat.is_expired) {
          unavailable.push(seat.id);
        }
      }
    }

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: unavailable });
    }

    // Update seats
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = NOW() + INTERVAL '${HOLD_TTL_SECONDS} seconds'
       WHERE id IN (${updatePlaceholders})
       RETURNING id, status, hold_id, hold_expires_at`,
      [holdId, ...seatIds]
    );

    await db.exec('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });

    res.json({
      holdId,
      expiresAt: updateRes.rows[0].hold_expires_at,
      seats: updateRes.rows
    });

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

  await expireHolds();

  try {
    await db.exec('BEGIN');

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(
      `SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY id FOR UPDATE`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.exec('COMMIT');
      return res.json({ success: true, seats: bookedRes.rows });
    }

    // Find held seats
    const heldRes = await db.query(
      `SELECT id, status, hold_expires_at, hold_expires_at <= NOW() as is_expired FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE`,
      [holdId]
    );

    if (heldRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const expired = heldRes.rows.some(seat => seat.is_expired);
    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(
      `UPDATE seats
       SET status = 'booked', booked_by = $2
       WHERE hold_id = $1
       RETURNING id, status`,
      [holdId, sessionId]
    );

    await db.exec('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });

    res.json({ success: true, seats: updateRes.rows });

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
    const updateRes = await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, status`,
      [holdId]
    );
    await db.exec('COMMIT');

    if (updateRes.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: updateRes.rows });
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

  const client = { id: uuidv4(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

initDb().then(() => {
  app.listen(3001, () => {
    console.log('Backend listening on port 3001');
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
