const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, '../db'));

const HOLD_TTL_MS = 60 * 1000; // 60 seconds

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
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
      for (let s = 1; s <= seatsPerRow; s++) {
        const id = `${r}${s}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [id, r, s]
        );
      }
    }
  }
}

// Helper to sweep expired holds
async function sweepExpiredHolds() {
  const now = Date.now();
  const res = await db.query(
    `UPDATE seats 
     SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
     WHERE status = 'held' AND hold_expires_at <= $1 
     RETURNING id`,
    [now]
  );
  if (res.rows.length > 0) {
    const releasedSeatIds = res.rows.map(r => r.id);
    broadcast('seats_updated', { seats: res.rows.map(r => ({ id: r.id, status: 'available', hold_id: null })) });
  }
}

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

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  res.json(result.rows);
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }

  await sweepExpiredHolds();

  const holdId = uuidv4();
  const expiresAt = Date.now() + HOLD_TTL_MS;

  try {
    await db.exec('BEGIN');

    // Lock the requested seats
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const seatsRes = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );

    const unavailable = seatsRes.rows.filter(s => s.status !== 'available');
    if (unavailable.length > 0 || seatsRes.rows.length !== seatIds.length) {
      await db.exec('ROLLBACK');
      const unavailableIds = unavailable.map(s => s.id);
      // Also find missing seats
      const foundIds = seatsRes.rows.map(s => s.id);
      const missingIds = seatIds.filter(id => !foundIds.includes(id));
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds: [...unavailableIds, ...missingIds] });
    }

    // Update seats
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${updatePlaceholders})`,
      [holdId, expiresAt, ...seatIds]
    );

    await db.exec('COMMIT');

    const updatedSeats = seatIds.map(id => ({ id, status: 'held', hold_id: holdId, hold_expires_at: expiresAt }));
    broadcast('seats_updated', { seats: updatedSeats });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    console.error(err); await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await sweepExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Check if already booked by this holdId (idempotency)
    const bookedRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'`,
      [holdId]
    );
    if (bookedRes.rows.length > 0) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, message: 'Already booked', seatIds: bookedRes.rows.map(r => r.id) });
    }

    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    const now = Date.now();
    const expired = seatsRes.rows.some(s => s.hold_expires_at <= now);
    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired' });
    }

    await db.query(
      `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
      [sessionId || 'unknown', holdId]
    );

    await db.exec('COMMIT');

    const updatedSeats = seatsRes.rows.map(s => ({ id: s.id, status: 'booked' }));
    broadcast('seats_updated', { seats: updatedSeats });

    res.json({ success: true, seatIds: updatedSeats.map(s => s.id) });
  } catch (err) {
    console.error(err); await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.exec('BEGIN');
    const seatsRes = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
      [holdId]
    );

    if (seatsRes.rows.length > 0) {
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
        [holdId]
      );
      await db.exec('COMMIT');

      const updatedSeats = seatsRes.rows.map(s => ({ id: s.id, status: 'available', hold_id: null }));
      broadcast('seats_updated', { seats: updatedSeats });
    } else {
      await db.exec('ROLLBACK');
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err); await db.exec('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Periodic sweep
setInterval(sweepExpiredHolds, 5000);

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
