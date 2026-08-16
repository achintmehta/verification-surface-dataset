import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { db, initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

let clients = [];

function broadcast(seats) {
  if (seats.length === 0) return;
  const data = JSON.stringify(seats);
  for (const client of clients) {
    client.res.write(`data: ${data}\n\n`);
  }
}

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    const now = Date.now();
    const released = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at < $1
      RETURNING id, status, hold_id, hold_expires_at, booked_by
    `, [now]);
    if (released.rows.length > 0) {
      broadcast(released.rows);
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}, 1000);

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
  const now = Date.now();
  // Force release expired holds before returning
  const released = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, status, hold_id, hold_expires_at, booked_by
  `, [now]);
  if (released.rows.length > 0) {
    broadcast(released.rows);
  }

  const seats = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(seats.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds: rawSeatIds, sessionId } = req.body;
  if (!rawSeatIds || !Array.isArray(rawSeatIds) || rawSeatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds array is required' });
  }
  const seatIds = [...new Set(rawSeatIds)];

  const now = Date.now();
  const TTL = 60 * 1000; // 60 seconds
  const expiresAt = now + TTL;
  const holdId = crypto.randomUUID();

  try {
    const result = await db.query(`
      WITH target_seats AS (
        SELECT id, status, hold_expires_at FROM seats WHERE id = ANY($1::text[])
      ),
      available_targets AS (
        SELECT id FROM target_seats 
        WHERE status = 'available' OR (status = 'held' AND hold_expires_at < $2)
      ),
      updated AS (
        UPDATE seats
        SET status = 'held', hold_id = $3, hold_expires_at = $4
        WHERE id IN (SELECT id FROM available_targets)
          AND (SELECT count(*) FROM available_targets) = array_length($1::text[], 1)
        RETURNING id, status, hold_id, hold_expires_at, booked_by
      )
      SELECT * FROM updated;
    `, [seatIds, now, holdId, expiresAt]);

    if (result.rows.length > 0) {
      broadcast(result.rows);
      return res.json({ holdId, expiresAt, seats: result.rows });
    } else {
      // Find which seats were conflicting
      const conflicts = await db.query(`
        SELECT id FROM seats 
        WHERE id = ANY($1::text[]) 
          AND NOT (status = 'available' OR (status = 'held' AND hold_expires_at < $2))
      `, [seatIds, now]);
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflicts: conflicts.rows.map(r => r.id) 
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  const now = Date.now();

  try {
    const result = await db.query(`
      WITH updated AS (
        UPDATE seats
        SET status = 'booked', booked_by = $3, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held' AND hold_expires_at >= $2
        RETURNING id, status, hold_id, hold_expires_at, booked_by
      ),
      already_booked AS (
        SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats
        WHERE hold_id = $1 AND status = 'booked'
      )
      SELECT * FROM updated UNION ALL SELECT * FROM already_booked;
    `, [holdId, now, sessionId || 'unknown']);

    if (result.rows.length > 0) {
      // Only broadcast if we actually updated something. 
      // If it was already booked, we might not need to broadcast, but broadcasting again is harmless.
      // Let's check if any were actually updated by checking if hold_expires_at is NULL and we just set it.
      // Actually, just broadcast.
      broadcast(result.rows);
      return res.json({ seats: result.rows });
    } else {
      return res.status(400).json({ error: 'Hold expired, invalid, or already overwritten' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  try {
    const result = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id, status, hold_id, hold_expires_at, booked_by
    `, [holdId]);

    if (result.rows.length > 0) {
      broadcast(result.rows);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Backend running on http://localhost:\${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
