import express from 'express';
import cors from 'cors';
import { db, initDb } from './db.js';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(cors());
app.use(express.json());

const HOLD_TTL_SECONDS = 60;

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

async function sweepExpiredHolds() {
  const now = new Date().toISOString();
  const res = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at <= $1
    RETURNING id
  `, [now]);
  if (res.rows.length > 0) {
    broadcast('seats_updated', res.rows.map(r => ({ id: r.id, status: 'available' })));
  }
}

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number`);
  const now = new Date().toISOString();
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
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  try {
    await db.query('BEGIN');
    
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(`
      SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE
    `, seatIds);

    const now = new Date().toISOString();
    const unavailable = seatsRes.rows.filter(s => {
      if (s.status === 'available') return false;
      if (s.status === 'held' && s.hold_expires_at <= now) return false;
      return true;
    });
    if (unavailable.length > 0 || seatsRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: unavailable.map(s => s.id) 
      });
    }

    const holdId = uuidv4();
    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    await db.query(`
      UPDATE seats
      SET status = 'held', hold_id = $1, hold_expires_at = $2
      WHERE id IN (${placeholders})
    `, [holdId, expiresAt, ...seatIds]);

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held' }));
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

    const bookedRes = await db.query(`
      SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'
    `, [holdId]);

    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seatIds: bookedRes.rows.map(r => r.id) });
    }

    const seatsRes = await db.query(`
      SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE
    `, [holdId]);

    if (seatsRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const now = new Date().toISOString();
    const expired = seatsRes.rows.some(s => s.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = seatsRes.rows.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(',');

    await db.query(`
      UPDATE seats
      SET status = 'booked', booked_by = $1, hold_expires_at = NULL
      WHERE id IN (${placeholders})
    `, [sessionId, ...seatIds]);

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'booked' }));
    broadcast('seats_updated', updatedSeats);

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
    const seatsRes = await db.query(`
      SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE
    `, [holdId]);

    if (seatsRes.rows.length > 0) {
      const seatIds = seatsRes.rows.map(s => s.id);
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE id IN (${placeholders})
      `, seatIds);
      await db.query('COMMIT');

      const updatedSeats = seatIds.map(id => ({ id, status: 'available' }));
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

setInterval(() => {
  sweepExpiredHolds().catch(console.error);
}, 5000);

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
  });
});