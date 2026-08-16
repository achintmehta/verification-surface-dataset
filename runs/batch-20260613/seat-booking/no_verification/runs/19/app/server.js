const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

const HOLD_TTL_SECONDS = 60;

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
      hold_expires_at TIMESTAMPTZ,
      session_id VARCHAR(36),
      booked_by VARCHAR(36)
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM seats`);
  if (parseInt(res.rows[0].count, 10) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (let r of rows) {
      for (let i = 1; i <= seatsPerRow; i++) {
        const id = `${r}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [id, r, i]
        );
      }
    }
  }
}

async function expireHolds() {
  try {
    const now = new Date().toISOString();
    const res = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL 
       WHERE status = 'held' AND hold_expires_at <= $1
       RETURNING id`,
      [now]
    );
    if (res.rows.length > 0) {
      broadcast({ type: 'seats_updated', seats: res.rows.map(r => ({ id: r.id, status: 'available' })) });
    }
  } catch (err) {
    console.error('Error expiring holds:', err);
  }
}

setInterval(expireHolds, 5000);

app.get('/api/seats', async (req, res) => {
  try {
    await expireHolds();
    const result = await db.query(`SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  await expireHolds();
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds array is required' });
  }

  const holdId = uuidv4();
  const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

  try {
    await db.query('BEGIN');
    
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = checkRes.rows.filter(r => r.status !== 'available');
    if (unavailable.length > 0 || checkRes.rows.length !== seatIds.length) {
      await db.query('ROLLBACK');
      const conflictingIds = unavailable.map(r => r.id);
      const foundIds = checkRes.rows.map(r => r.id);
      const missingIds = seatIds.filter(id => !foundIds.includes(id));
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: [...conflictingIds, ...missingIds] });
    }

    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2, session_id = $3 
       WHERE id IN (${placeholders})`,
      [holdId, expiresAt, sessionId, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: seatIds.map(id => ({ id, status: 'held' })) });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  await expireHolds();
  const { holdId } = req.params;
  const { sessionId } = req.body;

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

    const holdRes = await db.query(
      `SELECT id, status, hold_expires_at, session_id FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    if (holdRes.rows[0].status === 'booked') {
      await db.query('ROLLBACK');
      return res.json({ success: true, message: 'Already confirmed', seatIds: holdRes.rows.map(r => r.id) });
    }

    if (holdRes.rows.some(r => r.session_id !== sessionId)) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to confirm this hold' });
    }

    const now = new Date();
    const expired = holdRes.rows.some(r => new Date(r.hold_expires_at) <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = holdRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1 
       WHERE hold_id = $2`,
      [sessionId || 'unknown', holdId]
    );

    await db.query('COMMIT');

    broadcast({ type: 'seats_updated', seats: seatIds.map(id => ({ id, status: 'booked' })) });

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  try {
    await db.query('BEGIN');
    const holdRes = await db.query(
      `SELECT id, session_id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (holdRes.rows.length > 0) {
      if (holdRes.rows.some(r => r.session_id !== sessionId)) {
        await db.query('ROLLBACK');
        return res.status(403).json({ error: 'Not authorized to release this hold' });
      }
      const seatIds = holdRes.rows.map(r => r.id);
      await db.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL 
         WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast({ type: 'seats_updated', seats: seatIds.map(id => ({ id, status: 'available' })) });
      res.json({ success: true, seatIds });
    } else {
      await db.query('ROLLBACK');
      res.status(404).json({ error: 'Hold not found' });
    }
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

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
