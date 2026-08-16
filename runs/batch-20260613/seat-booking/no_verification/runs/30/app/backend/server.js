import express from 'express';
import cors from 'cors';
import { initDb, db, releaseExpiredHolds } from './db.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// SSE clients
let sseClients = [];

function broadcastSeatUpdate(seatIds, status, extra = {}) {
  const data = JSON.stringify({ seatIds, status, ...extra, timestamp: Date.now() });
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

async function enforceExpiry() {
  const released = await releaseExpiredHolds();
  if (released.length > 0) {
    broadcastSeatUpdate(released, 'available');
  }
}

// Periodic sweep every 5 seconds
setInterval(enforceExpiry, 5000);

app.get('/api/seats', async (req, res) => {
  await enforceExpiry();
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
             WHEN status = 'held' THEN 'available'
             ELSE status 
           END as effective_status,
           hold_id, hold_expires_at, booked_by
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  res.json(rows);
});

app.post('/api/holds', async (req, res) => {
  await enforceExpiry();
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL

  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: unavailable } = await db.query(`
      SELECT id FROM seats 
      WHERE id = ANY(ARRAY[${placeholders}]) 
      AND (status != 'available' OR (status = 'held' AND hold_expires_at > NOW()))
    `, seatIds);

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflictingSeats: unavailable.map(r => r.id) 
      });
    }

    // Acquire all
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
      WHERE id = ANY(ARRAY[${updatePlaceholders}])
    `, [...seatIds, holdId, expiresAt]);

    await db.exec('COMMIT');

    broadcastSeatUpdate(seatIds, 'held', { holdId, expiresAt, sessionId });
    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  await enforceExpiry();
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await db.exec('BEGIN');

    // Find seats for this hold
    const { rows: heldSeats } = await db.query(`
      SELECT id FROM seats 
      WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW()
    `, [holdId]);

    if (heldSeats.length === 0) {
      // Check if already booked by this hold (idempotency)
      const { rows: bookedSeats } = await db.query(`
        SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'
      `, [holdId]);
      if (bookedSeats.length > 0) {
        await db.exec('COMMIT');
        return res.json({ success: true, message: 'Already confirmed', seatIds: bookedSeats.map(r => r.id) });
      }
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const seatIds = heldSeats.map(r => r.id);

    // Book them
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $2
    `, [sessionId, holdId]);

    await db.exec('COMMIT');

    broadcastSeatUpdate(seatIds, 'booked', { bookedBy: sessionId });
    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.exec('BEGIN');

    const { rows: heldSeats } = await db.query(`
      SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'
    `, [holdId]);

    if (heldSeats.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const seatIds = heldSeats.map(r => r.id);

    await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1
    `, [holdId]);

    await db.exec('COMMIT');

    broadcastSeatUpdate(seatIds, 'available');
    res.json({ success: true, releasedSeats: seatIds });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

start();