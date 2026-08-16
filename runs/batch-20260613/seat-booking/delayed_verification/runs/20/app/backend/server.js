import express from 'express';
import cors from 'cors';
import { db, initDb } from './db.js';
import crypto from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

let clients = [];

function broadcast(data) {
  clients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('Error broadcasting to client', err);
    }
  });
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = crypto.randomUUID();
  clients.push({ id: clientId, res });

  req.on('close', () => {
    clients = clients.filter(client => client.id !== clientId);
  });
});

// Helper to sweep expired holds
async function sweepExpiredHolds() {
  const now = Date.now();
  const res = await db.query(
    `UPDATE seats 
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
     WHERE status = 'held' AND hold_expires_at <= $1 
     RETURNING id, status, hold_id, hold_expires_at`,
    [now]
  );
  if (res.rows.length > 0) {
    broadcast({ type: 'seats_updated', seats: res.rows });
  }
}

// Run sweep periodically
setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  const now = Date.now();
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

  const holdId = crypto.randomUUID();
  const expiresAt = Date.now() + HOLD_TTL_MS;

  try {
    await db.query('BEGIN');

    // Lock the requested seats
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const now = Date.now();
    const unavailable = seatsRes.rows.filter(s => 
      s.status === 'booked' || 
      (s.status === 'held' && s.hold_expires_at > now)
    );
    if (unavailable.length > 0 || seatsRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      const conflictingIds = unavailable.map(s => s.id);
      const foundIds = new Set(seatsRes.rows.map(s => s.id));
      const missingIds = seatIds.filter(id => !foundIds.has(id));
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: [...conflictingIds, ...missingIds] });
    }

    // Update seats
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${updatePlaceholders}) 
       RETURNING id, status, hold_id, hold_expires_at`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });
    res.json({ holdId, expiresAt, seats: updateRes.rows });
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
      `SELECT id, status, hold_id, hold_expires_at FROM seats WHERE hold_id = $1 AND status = 'booked' FOR UPDATE`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.query('COMMIT');
      return res.json({ success: true, seats: bookedRes.rows });
    }

    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const now = Date.now();
    const expired = seatsRes.rows.some(s => s.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1, hold_expires_at = NULL 
       WHERE hold_id = $2 
       RETURNING id, status, hold_id, hold_expires_at`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });
    res.json({ success: true, seats: updateRes.rows });
  } catch (err) {
    console.error(err);
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.query('BEGIN');
    const updateRes = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, status, hold_id, hold_expires_at`,
      [holdId]
    );
    await db.query('COMMIT');

    if (updateRes.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: updateRes.rows });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});