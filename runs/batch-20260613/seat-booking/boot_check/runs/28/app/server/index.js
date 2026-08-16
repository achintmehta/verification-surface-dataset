import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

app.use(cors());
app.use(express.json());

// Initialize PGLite with file system persistence
const db = new PGlite('./seat-booking-data');

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
    const values = [];
    for (const row of rows) {
      for (let num = 1; num <= seatsPerRow; num++) {
        const id = `${row}${num}`;
        values.push(`('${id}', '${row}', ${num}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(', ')}
    `);
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
  return result.rows.map(row => ({
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    expiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  }));
}

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    await releaseExpiredHolds();

    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

    // Use transaction for atomicity
    await db.exec('BEGIN');
    try {
      // Check all seats are available
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkResult = await db.query(`
        SELECT id, status FROM seats 
        WHERE id IN (${placeholders}) AND status != 'available'
      `, seatIds);

      if (checkResult.rows.length > 0) {
        await db.exec('ROLLBACK');
        const conflicting = checkResult.rows.map(r => r.id);
        return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
      }

      // Acquire all seats
      for (const seatId of seatIds) {
        await db.query(`
          UPDATE seats 
          SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id = $3 AND status = 'available'
        `, [holdId, expiresAt, seatId]);
      }

      await db.exec('COMMIT');

      broadcast('seats-held', { seatIds, holdId, sessionId, expiresAt });

      res.json({ 
        holdId, 
        expiresAt, 
        seatIds,
        ttlMs: HOLD_TTL_MS 
      });
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await releaseExpiredHolds();

    await db.exec('BEGIN');
    try {
      // Check if hold exists and is valid
      const holdResult = await db.query(`
        SELECT hold_id, status, hold_expires_at FROM seats 
        WHERE hold_id = $1 LIMIT 1
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const seat = holdResult.rows[0];
      if (seat.status !== 'held' || new Date(seat.hold_expires_at) < new Date()) {
        await db.exec('ROLLBACK');
        return res.status(410).json({ error: 'Hold expired or invalid' });
      }

      // Get all seats for this hold
      const seatsResult = await db.query(`
        SELECT id FROM seats WHERE hold_id = $1
      `, [holdId]);
      const seatIds = seatsResult.rows.map(r => r.id);

      // Book them - idempotent: only if still held by this hold
      await db.query(`
        UPDATE seats 
        SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $2 AND status = 'held'
      `, [sessionId, holdId]);

      await db.exec('COMMIT');

      broadcast('seats-booked', { seatIds, holdId, sessionId });

      res.json({ success: true, seatIds, bookedBy: sessionId });
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await releaseExpiredHolds();

    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id
    `, [holdId]);

    if (result.rows.length > 0) {
      const seatIds = result.rows.map(r => r.id);
      broadcast('seats-released', { seatIds });
      res.json({ success: true, releasedSeats: seatIds });
    } else {
      res.status(404).json({ error: 'Hold not found or already released' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    await releaseExpiredHolds();
  } catch (err) {
    console.error('Sweep error:', err);
  }
}, 30000); // every 30 seconds

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);