const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

let clients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.write(msg));
}

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
    broadcast({
      type: 'seats_updated',
      seats: res.rows.map(r => ({ id: r.id, status: 'available' }))
    });
  }
}

setInterval(() => {
  sweepExpiredHolds().catch(console.error);
}, 5000);

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push(res);

  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

app.get('/api/seats', async (req, res) => {
  try {
    await sweepExpiredHolds();
    const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/debug/expire', async (req, res) => {
  await db.query(`UPDATE seats SET hold_expires_at = 0 WHERE status = 'held'`);
  res.json({ success: true });
});

app.post('/api/holds', async (req, res) => {
  let { seatIds, sessionId } = req.body;
  if (!seatIds || !seatIds.length || !sessionId) {
    return res.status(400).json({ error: 'Missing seatIds or sessionId' });
  }
  seatIds = [...new Set(seatIds)];

  let conflictingSeatIds = [];
  try {
    await sweepExpiredHolds();

    let holdId = null;
    let expiresAt = null;

    await db.transaction(async (tx) => {
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkRes = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`,
        seatIds
      );

      const unavailable = checkRes.rows.filter(r => r.status !== 'available');
      const foundIds = checkRes.rows.map(r => r.id);
      const missingIds = seatIds.filter(id => !foundIds.includes(id));
      
      if (unavailable.length > 0 || missingIds.length > 0) {
        conflictingSeatIds = [...unavailable.map(r => r.id), ...missingIds];
        throw new Error('CONFLICT');
      }

      holdId = uuidv4();
      const ttl = 60 * 1000; // 60 seconds
      expiresAt = Date.now() + ttl;

      const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
      await tx.query(
        `UPDATE seats 
         SET status = 'held', hold_id = $1, hold_expires_at = $2 
         WHERE id IN (${updatePlaceholders})`,
        [holdId, expiresAt, ...seatIds]
      );
    });

    broadcast({
      type: 'seats_updated',
      seats: seatIds.map(id => ({ id, status: 'held' }))
    });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    if (err.message === 'CONFLICT') {
      return res.status(409).json({ error: 'Seats unavailable', conflictingSeatIds });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await sweepExpiredHolds();

    let bookedSeatIds = [];
    let alreadyBooked = false;

    await db.transaction(async (tx) => {
      const seatsWithHold = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1 FOR UPDATE`,
        [holdId]
      );

      if (seatsWithHold.rows.length === 0) {
        throw new Error('NOT_FOUND');
      }

      const allBooked = seatsWithHold.rows.every(r => r.status === 'booked');
      if (allBooked) {
        alreadyBooked = true;
        bookedSeatIds = seatsWithHold.rows.map(r => r.id);
        return;
      }

      const now = Date.now();
      const anyExpired = seatsWithHold.rows.some(r => r.hold_expires_at !== null && r.hold_expires_at <= now);
      if (anyExpired) {
        throw new Error('EXPIRED');
      }

      const anyNotHeld = seatsWithHold.rows.some(r => r.status !== 'held');
      if (anyNotHeld) {
        throw new Error('INVALID_STATE');
      }

      await tx.query(
        `UPDATE seats 
         SET status = 'booked', booked_by = $1, hold_expires_at = NULL 
         WHERE hold_id = $2`,
        [sessionId, holdId]
      );

      bookedSeatIds = seatsWithHold.rows.map(r => r.id);
    });

    if (!alreadyBooked) {
      broadcast({
        type: 'seats_updated',
        seats: bookedSeatIds.map(id => ({ id, status: 'booked' }))
      });
    }

    res.json({ holdId, seatIds: bookedSeatIds, status: 'booked' });
  } catch (err) {
    if (err.message === 'NOT_FOUND' || err.message === 'EXPIRED') {
      return res.status(404).json({ error: 'Hold not found or expired' });
    }
    if (err.message === 'INVALID_STATE') {
      return res.status(400).json({ error: 'Hold is in invalid state' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    let releasedSeatIds = [];

    await db.transaction(async (tx) => {
      const seatsWithHold = await tx.query(
        `SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'held' FOR UPDATE`,
        [holdId]
      );

      if (seatsWithHold.rows.length === 0) {
        return;
      }

      releasedSeatIds = seatsWithHold.rows.map(r => r.id);

      await tx.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
         WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
    });

    if (releasedSeatIds.length > 0) {
      broadcast({
        type: 'seats_updated',
        seats: releasedSeatIds.map(id => ({ id, status: 'available' }))
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
  if (res.rows[0].count == 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rows) {
      for (let i = 1; i <= 10; i++) {
        const id = `${row}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)`,
          [id, row, i, 'available']
        );
      }
    }
  }
}

initDb().then(() => {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});