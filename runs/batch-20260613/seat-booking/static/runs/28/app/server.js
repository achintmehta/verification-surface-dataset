import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

// PGLite instance - persists to local filesystem
const db = new PGlite(join(__dirname, 'data'));

// SSE clients
let sseClients = new Set();

// Broadcast seat status change
function broadcastSeatUpdate(seat) {
  const payload = JSON.stringify({
    type: 'seat-update',
    seat: {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      status: seat.status,
      hold_expires_at: seat.hold_expires_at
    }
  });
  
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function broadcastReset() {
  const payload = JSON.stringify({ type: 'seats-reset' });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

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
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Check if seats already seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0]?.count || 0;
  
  if (count === 0) {
    console.log('Seeding seat map: 5 rows x 10 seats...');
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    const params = [];
    let paramIdx = 1;
    
    for (const row of rows) {
      for (let num = 1; num <= 10; num++) {
        const id = `${row}${num}`;
        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        params.push(id, row, num);
      }
    }
    
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
    console.log('Seeded 50 seats.');
  }
}

// Release expired holds (lazy + sweep)
async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', 
        hold_id = NULL, 
        hold_expires_at = NULL 
    WHERE status = 'held' 
      AND hold_expires_at IS NOT NULL 
      AND hold_expires_at < $1
    RETURNING *
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    for (const seat of result.rows) {
      broadcastSeatUpdate(seat);
    }
  }
  
  return result.rows.length;
}

// Get all seats with effective status (expiry respected)
async function getAllSeats() {
  await releaseExpiredHolds();
  
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  
  return result.rows.map(row => ({
    id: row.id,
    row_label: row.row_label,
    seat_number: row.seat_number,
    status: row.status,
    hold_expires_at: row.hold_expires_at
  }));
}

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
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

// POST /api/holds - atomic all-or-nothing hold acquisition
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'seatIds array and sessionId required' });
  }
  
  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
  
  try {
    await db.exec('BEGIN');
    
    // First, release any expired holds
    await releaseExpiredHolds();
    
    // Check all seats are available and lock them
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats 
       WHERE id IN (${placeholders}) FOR UPDATE`,
      seatIds
    );
    
    const foundSeats = checkRes.rows;
    const foundIds = foundSeats.map(s => s.id);
    const missing = seatIds.filter(id => !foundIds.includes(id));
    
    if (missing.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Some seats not found', missing });
    }
    
    // Find unavailable seats
    const unavailable = foundSeats.filter(seat => {
      if (seat.status === 'booked') return true;
      if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date()) {
        return true;
      }
      return false;
    });
    
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'Some seats are unavailable',
        conflictingSeats: unavailable.map(s => s.id)
      });
    }
    
    // All good - acquire the hold atomically
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const updateParams = [holdId, expiresAt, ...seatIds];
    
    const updateRes = await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = $2 
      WHERE id IN (${updatePlaceholders})
      RETURNING *
    `, updateParams);
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    for (const seat of updateRes.rows) {
      broadcastSeatUpdate(seat);
    }
    
    res.status(201).json({
      id: holdId,
      seatIds,
      sessionId,
      expires_at: expiresAt,
      ttl: HOLD_TTL_MS
    });
    
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to acquire hold' });
  }
});

// POST /api/holds/:holdId/confirm - idempotent confirmation
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  
  try {
    await db.exec('BEGIN');
    
    await releaseExpiredHolds();
    
    // Find seats belonging to this hold
    const seatsRes = await db.query(
      `SELECT * FROM seats WHERE hold_id = $1 FOR UPDATE`,
      [holdId]
    );
    
    const heldSeats = seatsRes.rows;
    
    if (heldSeats.length === 0) {
      // Check if already booked under this hold (idempotency)
      const bookedRes = await db.query(
        `SELECT * FROM seats WHERE booked_by = $1`,
        [holdId]
      );
      
      if (bookedRes.rows.length > 0) {
        await db.exec('COMMIT');
        return res.json({
          success: true,
          seatIds: bookedRes.rows.map(s => s.id),
          message: 'Already confirmed'
        });
      }
      
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }
    
    // Verify not expired
    const now = new Date();
    const expired = heldSeats.some(seat => 
      seat.hold_expires_at && new Date(seat.hold_expires_at) < now
    );
    
    if (expired) {
      // Release them
      await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
         WHERE hold_id = $1`,
        [holdId]
      );
      await db.exec('COMMIT');
      return res.status(410).json({ error: 'Hold has expired' });
    }
    
    // Confirm: book the seats
    const updateRes = await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $1
      RETURNING *
    `, [holdId]);
    
    await db.exec('COMMIT');
    
    // Broadcast
    for (const seat of updateRes.rows) {
      broadcastSeatUpdate(seat);
    }
    
    res.json({
      success: true,
      seatIds: updateRes.rows.map(s => s.id),
      message: 'Booking confirmed'
    });
    
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// DELETE /api/holds/:holdId - release hold early
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $1
      RETURNING *
    `, [holdId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    for (const seat of result.rows) {
      broadcastSeatUpdate(seat);
    }
    
    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    console.error('Release error:', err);
    res.status(500).json({ error: 'Release failed' });
  }
});

// GET /api/stream - SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  sseClients.add(res);
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic expiry sweep
setInterval(async () => {
  try {
    const released = await releaseExpiredHolds();
    if (released > 0) {
      console.log(`Sweep released ${released} seats`);
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // every 30 seconds

// Start server
async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Frontend: http://localhost:5173`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
