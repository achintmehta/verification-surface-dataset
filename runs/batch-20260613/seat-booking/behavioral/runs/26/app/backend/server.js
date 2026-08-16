import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

// PGLite setup - persist to local disk
const dbPath = join(__dirname, 'seat_booking.db');
const db = new PGlite(dbPath);

let sseClients = new Set();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
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
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0].count;
  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    for (const row of rows) {
      for (let num = 1; num <= 10; num++) {
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

// Helper to release expired holds
async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, row_label, seat_number, status
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    // Broadcast releases
    result.rows.forEach(seat => {
      broadcastSeatUpdate({ ...seat, status: 'available' });
    });
  }
  return result.rows;
}

// Broadcast seat update to all SSE clients
function broadcastSeatUpdate(seat) {
  const data = JSON.stringify({ type: 'seat-update', seat });
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Get all seats with effective status (expiry check)
async function getAllSeats() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows.map(row => ({
    ...row,
    // Ensure effective status
    status: (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date()) ? 'available' : row.status
  }));)) 
      ? 'available' : row.status
  }));
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  req.on('close', () => {
    sseClients.delete(client);
  });
});

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// POST /api/holds - atomic hold acquisition
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE id IN (${placeholders})
    `, seatIds);

    const conflicting = [];
    for (const seat of checkRes.rows) {
      const effectiveStatus = (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date())
        ? 'available' : seat.status;
      if (effectiveStatus !== 'available') {
        conflicting.push(seat.id);
      }
    }

    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // Create hold - use a holdId
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

    // Update all seats atomically
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
      WHERE id IN (${updatePlaceholders})
    `, [...seatIds, holdId, expiresAt]);

    await db.exec('COMMIT');

    // Fetch updated seats for broadcast
    const updatedSeatsRes = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at 
      FROM seats WHERE id IN (${placeholders})
    `, seatIds);

    updatedSeatsRes.rows.forEach(seat => {
      broadcastSeatUpdate(seat);
    });

    res.json({
      id: holdId,
      seatIds,
      sessionId,
      expires_at: expiresAt,
      status: 'active'
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm - idempotent confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Find seats for this hold
    const holdRes = await db.query(`
      SELECT id, status, hold_id, hold_expires_at, booked_by 
      FROM seats 
      WHERE hold_id = $1
    `, [holdId]);

    if (holdRes.rows.length === 0) {
      // Check if already booked under this hold? For idempotency, check booked seats
      const bookedRes = await db.query(`
        SELECT id FROM seats WHERE booked_by = $1 AND status = 'booked'
      `, [holdId]);
      if (bookedRes.rows.length > 0) {
        await db.exec('COMMIT');
        return res.json({ success: true, message: 'Already confirmed', seatIds: bookedRes.rows.map(r => r.id) });
      }
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }

    // Check expiry and ownership (though we use hold_id)
    const now = new Date();
    const expired = holdRes.rows.some(seat => 
      seat.hold_expires_at && new Date(seat.hold_expires_at) < now
    );
    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired' });
    }

    // Book them - use holdId as booked_by for traceability
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $2
    `, [holdId, holdId]);

    await db.exec('COMMIT');

    // Broadcast updates
    const updatedRes = await db.query(`
      SELECT id, row_label, seat_number, status, booked_by 
      FROM seats WHERE booked_by = $1
    `, [holdId]);
    updatedRes.rows.forEach(seat => broadcastSeatUpdate(seat));

    const seatIds = holdRes.rows.map(r => r.id);
    res.json({ success: true, seatIds, message: 'Seats booked successfully' });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

// DELETE /api/holds/:holdId - release hold
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id, row_label, seat_number
    `, [holdId]);

    if (result.rows.length > 0) {
      result.rows.forEach(seat => {
        broadcastSeatUpdate({ ...seat, status: 'available' });
      });
    }

    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// Periodic sweep for expired holds
setInterval(async () => {
  await releaseExpiredHolds();
}, 30000); // every 30s

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);