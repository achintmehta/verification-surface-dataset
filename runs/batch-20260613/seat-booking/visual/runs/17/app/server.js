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
      id VARCHAR(10) PRIMARY KEY,
      row_label VARCHAR(2),
      seat_number INT,
      status VARCHAR(20) DEFAULT 'available',
      hold_id VARCHAR(36),
      hold_expires_at BIGINT,
      booked_by VARCHAR(36)
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM seats`);
  if (parseInt(res.rows[0].count) === 0) {
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

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    const now = Date.now();
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= $1
      RETURNING id
    `, [now]);
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}, 5000);

app.get('/api/seats', async (req, res) => {
  try {
    const now = Date.now();
    // Treat expired holds as available
    const result = await db.query(`
      SELECT id, row_label, seat_number, 
        CASE 
          WHEN status = 'held' AND hold_expires_at <= $1 THEN 'available'
          ELSE status 
        END as status,
        CASE 
          WHEN status = 'held' AND hold_expires_at <= $1 THEN NULL
          ELSE hold_id 
        END as hold_id,
        CASE 
          WHEN status = 'held' AND hold_expires_at <= $1 THEN NULL
          ELSE hold_expires_at 
        END as hold_expires_at,
        booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `, [now]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Missing seatIds or sessionId' });
  }

  try {
    await db.query('BEGIN');

    // Lock the requested seats
    const seatsRes = await db.query(`
      SELECT id, status, hold_expires_at 
      FROM seats 
      WHERE id = ANY($1) 
      FOR UPDATE
    `, [seatIds]);

    if (seatsRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid seat IDs' });
    }

    const now = Date.now();
    const conflictingSeats = [];
    for (const seat of seatsRes.rows) {
      const isAvailable = seat.status === 'available' || (seat.status === 'held' && seat.hold_expires_at <= now);
      if (!isAvailable) {
        conflictingSeats.push(seat.id);
      }
    }

    if (conflictingSeats.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Seats not available', conflictingSeats });
    }

    const holdId = uuidv4();
    const expiresAt = now + HOLD_TTL_SECONDS * 1000;

    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = $2 
      WHERE id = ANY($3)
    `, [holdId, expiresAt, seatIds]);

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  try {
    await db.query('BEGIN');

    // Lock the seats for this hold
    const seatsRes = await db.query(`
      SELECT id, status, hold_expires_at 
      FROM seats 
      WHERE hold_id = $1 
      FOR UPDATE
    `, [holdId]);

    if (seatsRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    // Check if already booked
    if (seatsRes.rows[0].status === 'booked') {
      await db.query('ROLLBACK');
      return res.json({ success: true, message: 'Already booked', seatIds: seatsRes.rows.map(r => r.id) });
    }

    // Verify hold is not expired
    const now = Date.now();
    const isExpired = seatsRes.rows[0].hold_expires_at <= now;

    if (isExpired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = seatsRes.rows.map(r => r.id);

    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1 
      WHERE hold_id = $2
    `, [sessionId, holdId]);

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'booked' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.query('BEGIN');

    const seatsRes = await db.query(`
      SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE
    `, [holdId]);

    if (seatsRes.rows.length > 0) {
      const seatIds = seatsRes.rows.map(r => r.id);
      await db.query(`
        UPDATE seats 
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
        WHERE hold_id = $1
      `, [holdId]);

      await db.query('COMMIT');

      const updatedSeats = seatIds.map(id => ({ id, status: 'available' }));
      broadcast({ type: 'seats_updated', seats: updatedSeats });
    } else {
      await db.query('ROLLBACK');
    }

    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const client = { id: uuidv4(), res };
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
}).catch(err => {
  console.error('Failed to initialize DB', err);
});
