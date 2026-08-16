const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite instance - persisted to local filesystem
let db;
const DB_PATH = './pgdata';

// Hold TTL in milliseconds (e.g., 2 minutes for demo)
const HOLD_TTL_MS = 2 * 60 * 1000;

// SSE clients
let sseClients = [];

// Initialize database
async function initDb() {
  db = new PGlite(DB_PATH);
  await db.waitReady;

  // Create seats table
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
  const count = parseInt(result.rows[0].count);

  if (count === 0) {
    // Seed 5 rows x 10 seats
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const insertPromises = [];
    for (const row of rows) {
      for (let seatNum = 1; seatNum <= 10; seatNum++) {
        const id = `${row}${seatNum}`;
        insertPromises.push(
          db.query(
            `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
            [id, row, seatNum]
          )
        );
      }
    }
    await Promise.all(insertPromises);
    console.log('Seeded 50 seats');
  }

  // Initial expiry sweep
  await releaseExpiredHolds();
  console.log('Database initialized');
}

// Release expired holds
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
    console.log(`Released expired holds for seats: ${releasedIds.join(', ')}`);
    broadcastSeatUpdate(releasedIds, 'available');
  }
  return result.rows.length;
}

// Get effective status for a seat (considering expiry)
async function getSeats() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

// Broadcast seat status changes via SSE
function broadcastSeatUpdate(seatIds, status, extra = {}) {
  const eventData = JSON.stringify({ seatIds, status, ...extra, timestamp: Date.now() });
  sseClients.forEach((client, index) => {
    try {
      client.res.write(`data: ${eventData}\n\n`);
    } catch (e) {
      sseClients.splice(index, 1);
    }
  });
}

// API: GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    // Compute inventory
    let available = 0, held = 0, booked = 0;
    seats.forEach(seat => {
      if (seat.status === 'available') available++;
      else if (seat.status === 'held') held++;
      else if (seat.status === 'booked') booked++;
    });
    res.json({ seats, inventory: { available, held, booked, total: seats.length } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: POST /api/holds
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'seatIds array and sessionId required' });
  }

  try {
    await releaseExpiredHolds();

    // Use transaction for atomicity
    await db.exec('BEGIN');
    try {
      // Check all seats are available
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkResult = await db.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );

      const unavailable = [];
      const availableSeats = [];
      checkResult.rows.forEach(row => {
        if (row.status !== 'available' || (row.hold_expires_at && new Date(row.hold_expires_at) <= new Date())) {
          unavailable.push(row.id);
        } else {
          availableSeats.push(row.id);
        }
      });

      if (unavailable.length > 0) {
        await db.exec('ROLLBACK');
        return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: unavailable });
      }

      if (availableSeats.length !== seatIds.length) {
        await db.exec('ROLLBACK');
        return res.status(409).json({ error: 'Seat count mismatch' });
      }

      // Create hold
      const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

      // Update all seats to held
      for (const seatId of seatIds) {
        await db.query(
          `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = $3`,
          [holdId, expiresAt, seatId]
        );
      }

      await db.exec('COMMIT');

      // Broadcast updates
      broadcastSeatUpdate(seatIds, 'held', { holdId, expiresAt, sessionId });

      res.json({ holdId, seatIds, expiresAt, sessionId });
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// API: POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  try {
    await releaseExpiredHolds();

    await db.exec('BEGIN');
    try {
      // Find seats for this hold
      const holdResult = await db.query(
        `SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      if (holdResult.rows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Hold not found' });
      }

      const seats = holdResult.rows;
      const now = new Date();

      // Idempotency check: already booked under this hold
      const alreadyBooked = seats.every(seat => seat.status === 'booked' && seat.hold_id === holdId);
      if (alreadyBooked) {
        await db.exec('COMMIT');
        return res.json({ success: true, message: 'Already confirmed', seatIds: seats.map(s => s.id) });
      }

      // Check if any expired or invalid
      const expiredOrInvalid = seats.some(seat => 
        seat.status !== 'held' || 
        (seat.hold_expires_at && new Date(seat.hold_expires_at) <= now)
      );

      if (expiredOrInvalid) {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: 'Hold expired or invalid' });
      }

      // Book them
      const seatIds = seats.map(s => s.id);
      for (const seatId of seatIds) {
        await db.query(
          `UPDATE seats SET status = 'booked', booked_by = $1, hold_expires_at = NULL WHERE id = $2`,
          [sessionId || holdId, seatId]
        );
      }

      await db.exec('COMMIT');

      broadcastSeatUpdate(seatIds, 'booked', { holdId });

      res.json({ success: true, seatIds });
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

// API: DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await releaseExpiredHolds();

    const result = await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1 AND status = 'held' RETURNING id`,
      [holdId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hold not found or already released' });
    }

    const releasedIds = result.rows.map(r => r.id);
    broadcastSeatUpdate(releasedIds, 'available');

    res.json({ success: true, releasedSeats: releasedIds });
  } catch (err) {
    console.error('Release error:', err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// SSE endpoint: GET /api/stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  const client = { res };
  sseClients.push(client);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

// Periodic sweep for expired holds (every 30 seconds)
setInterval(async () => {
  try {
    const released = await releaseExpiredHolds();
    if (released > 0) {
      console.log(`Periodic sweep released ${released} seats`);
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000);

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);