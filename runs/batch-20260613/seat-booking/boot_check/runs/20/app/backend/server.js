import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { db, initDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
}

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

async function sweepExpiredHolds() {
  const now = Date.now();
  try {
    await db.transaction(async (tx) => {
      const res = await tx.query(
        `SELECT id FROM seats WHERE status = 'held' AND hold_expires_at <= $1 ORDER BY id FOR UPDATE SKIP LOCKED`,
        [now]
      );
      
      if (res.rows.length > 0) {
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at <= $1`,
          [now]
        );
        const releasedSeats = res.rows.map(r => r.id);
        broadcast({ type: 'released', seats: releasedSeats });
      }
    });
  } catch (err) {
    console.error('Sweep error:', err);
  }
}

// Periodic sweep
setInterval(sweepExpiredHolds, 5000);

app.get('/api/seats', async (req, res) => {
  await sweepExpiredHolds();
  try {
    const result = await db.query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
    const now = Date.now();
    const seats = result.rows.map(seat => {
      if (seat.status === 'held' && seat.hold_expires_at <= now) {
        return { ...seat, status: 'available', hold_id: null, hold_expires_at: null };
      }
      return seat;
    });
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'Invalid seatIds' });
  }

  await sweepExpiredHolds();

  const holdId = uuidv4();
  const ttl = 60 * 1000; // 60 seconds
  const expiresAt = Date.now() + ttl;

  try {
    await db.transaction(async (tx) => {
      const sortedSeatIds = [...seatIds].sort();
      const placeholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const checkRes = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
        sortedSeatIds
      );

      const now = Date.now();
      const unavailable = checkRes.rows.filter(r => {
        if (r.status === 'available') return false;
        if (r.status === 'held' && r.hold_expires_at <= now) return false;
        return true;
      }).map(r => r.id);
      const missing = sortedSeatIds.filter(id => !checkRes.rows.find(r => r.id === id));
      
      if (unavailable.length > 0 || missing.length > 0) {
        const err = new Error('Seats unavailable');
        err.status = 409;
        err.conflictingSeats = [...unavailable, ...missing];
        throw err;
      }

      await tx.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN (${placeholders})`,
        [holdId, expiresAt, ...sortedSeatIds]
      );
    });

    broadcast({ type: 'held', seats: seatIds, holdId, expiresAt });
    res.json({ holdId, expiresAt, seats: seatIds });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, conflictingSeats: err.conflictingSeats });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await sweepExpiredHolds();

  try {
    let bookedSeats = [];
    let alreadyBooked = false;

    await db.transaction(async (tx) => {
      const checkRes = await tx.query(
        `SELECT id, status, hold_id, hold_expires_at FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE`,
        [holdId]
      );

      if (checkRes.rows.length === 0) {
        const err = new Error('Hold not found or expired');
        err.status = 404;
        throw err;
      }

      const allBooked = checkRes.rows.every(r => r.status === 'booked');
      if (allBooked) {
        alreadyBooked = true;
        bookedSeats = checkRes.rows.map(r => r.id);
        return;
      }

      const now = Date.now();
      const expired = checkRes.rows.some(r => r.status === 'held' && r.hold_expires_at <= now);
      if (expired) {
        const err = new Error('Hold expired');
        err.status = 400;
        throw err;
      }

      const anyNotHeld = checkRes.rows.some(r => r.status !== 'held');
      if (anyNotHeld) {
        const err = new Error('Invalid hold state');
        err.status = 400;
        throw err;
      }

      await tx.query(
        `UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2`,
        [sessionId, holdId]
      );
      bookedSeats = checkRes.rows.map(r => r.id);
    });

    if (!alreadyBooked) {
      broadcast({ type: 'booked', seats: bookedSeats, holdId });
    }
    res.json({ holdId, seats: bookedSeats, status: 'booked' });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    let releasedSeats = [];
    await db.transaction(async (tx) => {
      const checkRes = await tx.query(
        `SELECT id, status FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY id FOR UPDATE`,
        [holdId]
      );

      if (checkRes.rows.length > 0) {
        await tx.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        releasedSeats = checkRes.rows.map(r => r.id);
      }
    });

    if (releasedSeats.length > 0) {
      broadcast({ type: 'released', seats: releasedSeats });
    }
    res.json({ success: true, releasedSeats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});