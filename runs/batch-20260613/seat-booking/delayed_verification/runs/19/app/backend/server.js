import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import db, { initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

let clients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    try {
      client.res.write(msg);
    } catch (e) {
      // ignore
    }
  });
}

async function sweepExpiredHolds() {
  const now = Date.now();
  try {
    const res = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL 
       WHERE status = 'held' AND hold_expires_at <= $1 
       RETURNING id`,
      [now]
    );
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}

setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  try {
    const result = await db.query(`SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, held_by, booked_by FROM seats ORDER BY row_label, seat_number`);
    const now = Date.now();
    const rows = result.rows.map(r => {
      if (r.status === 'held' && r.hold_expires_at <= now) {
        return { ...r, status: 'available', hold_id: null, hold_expires_at: null, held_by: null };
      }
      return r;
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await sweepExpiredHolds();

  const now = Date.now();
  const expiresAt = now + HOLD_TTL_MS;
  const holdId = uuidv4();

  try {
    await db.query('BEGIN');

    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = checkRes.rows.filter(r => {
      if (r.status === 'available') return false;
      if (r.status === 'held' && r.hold_expires_at <= now) return false;
      return true;
    });
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: unavailable.map(r => r.id) 
      });
    }

    const expiredSeats = checkRes.rows.filter(r => r.status === 'held' && r.hold_expires_at <= now);
    if (expiredSeats.length > 0) {
      broadcast({ type: 'seats_updated', seats: expiredSeats.map(r => ({ id: r.id, status: 'available' })) });
    }

    const updateParams = [holdId, expiresAt, sessionId, ...seatIds];
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 4}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2, held_by = $3 
       WHERE id IN (${updatePlaceholders})`,
      updateParams
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    console.error(err);
    await db.query('ROLLBACK');
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
      return res.json({ success: true, message: 'Already booked', seatIds: bookedRes.rows.map(r => r.id) });
    }

    const holdRes = await db.query(
      `SELECT id, status, hold_expires_at, held_by FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const invalidOwner = holdRes.rows.some(r => r.held_by !== sessionId);
    if (invalidOwner) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Hold owned by another session' });
    }

    const now = Date.now();
    const expired = holdRes.rows.some(r => r.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = holdRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1 
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'booked' }));
    broadcast({ type: 'seats_updated', seats: updatedSeats });

    res.json({ success: true, seatIds });
  } catch (err) {
    console.error(err);
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await db.query('BEGIN');
    const holdRes = await db.query(
      `SELECT id, held_by FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length > 0) {
      const invalidOwner = holdRes.rows.some(r => r.held_by !== sessionId);
      if (invalidOwner) {
        await db.query('ROLLBACK');
        return res.status(403).json({ error: 'Hold owned by another session' });
      }

      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');

      const updatedSeats = holdRes.rows.map(r => ({ id: r.id, status: 'available' }));
      broadcast({ type: 'seats_updated', seats: updatedSeats });
    } else {
      await db.query('ROLLBACK');
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    await db.query('ROLLBACK');
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
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
