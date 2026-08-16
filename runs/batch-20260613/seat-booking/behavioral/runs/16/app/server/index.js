const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./seat-booking-db');

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
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (parseInt(res.rows[0].count) === 0) {
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

async function releaseExpiredHolds() {
  const now = Date.now();
  const res = await db.query(
    `UPDATE seats 
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
     WHERE status = 'held' AND hold_expires_at <= $1 
     RETURNING id`,
    [now]
  );
  if (res.rows.length > 0) {
    const releasedIds = res.rows.map(r => r.id);
    broadcast({ type: 'released', seatIds: releasedIds });
  }
}

app.get('/api/seats', async (req, res) => {
  await releaseExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  await releaseExpiredHolds();
  const { seatIds, sessionId } = req.body;
  if (!seatIds || seatIds.length === 0) {
    return res.status(400).json({ error: 'No seats requested' });
  }

  const holdId = uuidv4();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

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
      const foundIds = new Set(checkRes.rows.map(r => r.id));
      const missingIds = seatIds.filter(id => !foundIds.has(id));
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: [...conflictingIds, ...missingIds] });
    }

    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $1, hold_expires_at = $2 
       WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.query('COMMIT');

    broadcast({ type: 'held', seatIds, holdId, expiresAt });
    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  await releaseExpiredHolds();
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
      return res.json({ success: true, seatIds: bookedRes.rows.map(r => r.id) });
    }

    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (checkRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const now = Date.now();
    const expired = checkRes.rows.some(r => r.hold_expires_at <= now);
    if (expired) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    const seatIds = checkRes.rows.map(r => r.id);

    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1 
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.query('COMMIT');

    broadcast({ type: 'booked', seatIds, holdId });
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
    const checkRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );
    if (checkRes.rows.length > 0) {
      const seatIds = checkRes.rows.map(r => r.id);
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.query('COMMIT');
      broadcast({ type: 'released', seatIds });
      res.json({ success: true });
    } else {
      await db.query('ROLLBACK');
      res.json({ success: true });
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

setInterval(() => {
  releaseExpiredHolds().catch(console.error);
}, 5000);

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}).catch(console.error);

module.exports = { app, db, initDb };
