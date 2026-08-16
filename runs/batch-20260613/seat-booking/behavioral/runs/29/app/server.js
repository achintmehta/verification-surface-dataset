import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// PGLite setup with file persistence
const db = new PGlite('./seat-booking.db');

// SSE clients
let sseClients = new Set();

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );
  `);

  // Check if seats are seeded
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  if (result.rows[0].count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (const row of rows) {
      for (let num = 1; num <= seatsPerRow; num++) {
        const id = `${row}${num}`;
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
          [id, row, num, 'available']
        );
      }
    }
    console.log('Seeded 50 seats');
  }
}

async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);
  
  if (result.rows.length > 0) {
    const releasedIds = result.rows.map(r => r.id);
    console.log('Released expired holds:', releasedIds);
    broadcast('seats-released', { seatIds: releasedIds });
    return releasedIds;
  }
  return [];
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows.map(row => {
    let effectiveStatus = row.status;
    if (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date()) {
      effectiveStatus = 'available';
    }
    return {
      id: row.id,
      row: row.row_label,
      number: row.seat_number,
      status: effectiveStatus,
      holdId: row.hold_id,
      bookedBy: row.booked_by
    };
  });
}

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await releaseExpiredHolds();

  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL

  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );
    
    const unavailable = [];
    for (const seat of checkResult.rows) {
      if (seat.status !== 'available' || 
          (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date())) {
        unavailable.push(seat.id);
      }
    }
    
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeatIds: unavailable });
    }

    // Atomically hold them
    for (const seatId of seatIds) {
      await db.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = $3 AND status = 'available'`,
        [holdId, expiresAt, seatId]
      );
    }

    await db.exec('COMMIT');

    broadcast('seats-held', { seatIds, holdId, sessionId, expiresAt });
    
    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Find seats for this hold
    const seatsResult = await db.query(
      `SELECT id, status, hold_expires_at, hold_id FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    if (seatsResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const now = new Date();
    const expired = seatsResult.rows.some(seat => 
      seat.hold_expires_at && new Date(seat.hold_expires_at) < now
    );

    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired' });
    }

    // Verify ownership implicitly by hold_id, and all still held
    const allHeld = seatsResult.rows.every(seat => seat.status === 'held');
    if (!allHeld) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Hold no longer valid' });
    }

    // Book them - idempotent: only if still held by this hold
    const bookedSeats = [];
    for (const seat of seatsResult.rows) {
      const updateResult = await db.query(
        `UPDATE seats SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
         WHERE id = $2 AND hold_id = $3 AND status = 'held'`,
        [sessionId, seat.id, holdId]
      );
      if (updateResult.rowCount > 0) {
        bookedSeats.push(seat.id);
      }
    }

    await db.exec('COMMIT');

    if (bookedSeats.length > 0) {
      broadcast('seats-booked', { seatIds: bookedSeats, bookedBy: sessionId });
    }

    res.json({ success: true, bookedSeatIds: bookedSeats.length > 0 ? bookedSeats : seatsResult.rows.map(s => s.id) });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held' RETURNING id`,
      [holdId]
    );

    if (result.rows.length > 0) {
      const releasedIds = result.rows.map(r => r.id);
      broadcast('seats-released', { seatIds: releasedIds });
      res.json({ success: true, releasedSeatIds: releasedIds });
    } else {
      res.status(404).json({ error: 'Hold not found or already released' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic expiry sweep
setInterval(async () => {
  await releaseExpiredHolds();
}, 30000); // every 30s

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);