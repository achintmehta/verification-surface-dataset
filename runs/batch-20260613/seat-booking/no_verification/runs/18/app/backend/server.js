const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

let clients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => client.res.write(msg));
}

async function sweepExpiredHolds() {
  try {
    const now = Date.now();
    const res = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= $1
      RETURNING id, status, hold_id, hold_expires_at, booked_by
    `, [now]);
    
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows });
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

// Periodically sweep
setInterval(sweepExpiredHolds, 1000);

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
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  await sweepExpiredHolds();
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const holdId = crypto.randomUUID();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.query('BEGIN');
    
    // Check availability
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(`
      SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE
    `, seatIds);

    const unavailable = checkRes.rows.filter(s => s.status !== 'available');
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      const conflictingIds = unavailable.map(s => s.id);
      // Also find missing ids
      const foundIds = new Set(checkRes.rows.map(s => s.id));
      for (const id of seatIds) {
        if (!foundIds.has(id)) conflictingIds.push(id);
      }
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: conflictingIds });
    }

    // Update seats
    const updateRes = await db.query(`
      UPDATE seats
      SET status = 'held', hold_id = $1, hold_expires_at = $2
      WHERE id IN (${placeholders})
      RETURNING id, status, hold_id, hold_expires_at, booked_by
    `, [holdId, expiresAt, ...seatIds]);

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });
    res.json({ holdId, expiresAt, seats: updateRes.rows });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  await sweepExpiredHolds();
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await db.query('BEGIN');

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(`
      SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1 AND status = 'booked'
    `, [holdId]);

    if (bookedRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.json({ success: true, seats: bookedRes.rows });
    }

    // Find held seats
    const heldRes = await db.query(`
      SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE
    `, [holdId]);

    if (heldRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }

    const now = Date.now();
    const expired = heldRes.rows.some(s => s.status !== 'held' || s.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const updateRes = await db.query(`
      UPDATE seats
      SET status = 'booked', booked_by = $2
      WHERE hold_id = $1
      RETURNING id, status, hold_id, hold_expires_at, booked_by
    `, [holdId, sessionId]);

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: updateRes.rows });
    res.json({ success: true, seats: updateRes.rows });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  await sweepExpiredHolds();
  const { holdId } = req.params;

  try {
    await db.query('BEGIN');
    const updateRes = await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id, status, hold_id, hold_expires_at, booked_by
    `, [holdId]);
    await db.query('COMMIT');

    if (updateRes.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: updateRes.rows });
    }
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
  });
});
