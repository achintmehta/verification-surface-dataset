import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import db, { initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();

function broadcast(event, data) {
  for (const client of clients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
      broadcast('seats_updated', { seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

// Periodic sweep every 5 seconds
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
  try {
    const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
    const now = Date.now();
    const seats = result.rows.map(r => {
      if (r.status === 'held' && r.hold_expires_at <= now) {
        return { ...r, status: 'available', hold_id: null, hold_expires_at: null };
      }
      return r;
    });
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !seatIds.length || !sessionId) {
    return res.status(400).json({ error: 'Missing seatIds or sessionId' });
  }

  await sweepExpiredHolds();

  const holdId = crypto.randomUUID();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');

    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const now = Date.now();
    const unavailable = checkRes.rows.filter(r => {
      if (r.status === 'available') return false;
      if (r.status === 'held' && r.hold_expires_at <= now) return false;
      return true;
    });
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      const conflictingIds = unavailable.map(r => r.id);
      const foundIds = new Set(checkRes.rows.map(r => r.id));
      for (const id of seatIds) {
        if (!foundIds.has(id)) conflictingIds.push(id);
      }
      return res.status(409).json({ error: 'Seats unavailable', conflictingIds });
    }

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held', hold_id: holdId, hold_expires_at: expiresAt }));
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

    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, message: 'Already confirmed', seatIds: bookedRes.rows.map(r => r.id) });
    }

    const heldRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (heldRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const now = Date.now();
    const expired = heldRes.rows.some(r => r.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = heldRes.rows.map(r => r.id);
    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1, hold_expires_at = NULL 
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'booked', booked_by: sessionId }));
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
    const heldRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (heldRes.rows.length > 0) {
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');

      const updatedSeats = heldRes.rows.map(r => ({ id: r.id, status: 'available' }));
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

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
