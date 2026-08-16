import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup with persistence
const db = new PGlite(join(__dirname, 'seats.db'));

const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

// SSE clients
let sseClients = new Set();

// Broadcast seat status change
function broadcastSeatUpdate(seat) {
  const data = JSON.stringify({ type: 'seat_update', seat });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Broadcast multiple updates
function broadcastUpdates(seats) {
  for (const seat of seats) {
    broadcastSeatUpdate(seat);
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
      booked_by TEXT
    );
  `);

  // Check if seats are seeded
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = result.rows[0].count;
  if (count === 0) {
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

// Enforce expiry: release expired holds
async function enforceExpiry() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    broadcastUpdates(result.rows);
  }
  return result.rows;
}

// Get all seats with effective status
async function getAllSeats() {
  await enforceExpiry();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

// Atomic hold acquisition
async function createHold(seatIds, sessionId) {
  await enforceExpiry();
  
  return await db.transaction(async (tx) => {
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await tx.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE id IN (${placeholders})
    `, seatIds);
    
    const unavailable = [];
    for (const seat of checkResult.rows) {
      if (seat.status !== 'available' || 
          (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date())) {
        unavailable.push(seat.id);
      }
    }
    
    if (unavailable.length > 0) {
      return { success: false, conflicts: unavailable };
    }
    
    // All available, create hold
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
    
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    const updateResult = await tx.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = $2
      WHERE id IN (${updatePlaceholders})
      RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    `, [holdId, expiresAt, ...seatIds]);
    
    return { 
      success: true, 
      holdId, 
      expiresAt, 
      seats: updateResult.rows 
    };
  });
}

// Confirm hold (idempotent)
async function confirmHold(holdId, sessionId) {
  await enforceExpiry();
  
  return await db.transaction(async (tx) => {
    // Find seats for this hold
    const seatsResult = await tx.query(`
      SELECT id, status, hold_expires_at, hold_id FROM seats 
      WHERE hold_id = $1
    `, [holdId]);
    
    if (seatsResult.rows.length === 0) {
      // Check if already booked by this hold (idempotency)
      const bookedResult = await tx.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
        FROM seats 
        WHERE booked_by = $1 AND status = 'booked'
      `, [holdId]);
      
      if (bookedResult.rows.length > 0) {
        return { success: true, alreadyConfirmed: true, seats: bookedResult.rows };
      }
      return { success: false, error: 'Hold not found or expired' };
    }
    
    // Check if any expired (should be caught by enforce but double check)
    const now = new Date();
    const expired = seatsResult.rows.some(s => 
      s.hold_expires_at && new Date(s.hold_expires_at) < now
    );
    if (expired) {
      return { success: false, error: 'Hold expired' };
    }
    
    // Book them
    const updateResult = await tx.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1
      RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    `, [holdId]);
    
    return { success: true, seats: updateResult.rows };
  });
}

// Release hold early
async function releaseHold(holdId) {
  await enforceExpiry();
  
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE hold_id = $1 AND status = 'held'
    RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
  `, [holdId]);
  
  if (result.rows.length > 0) {
    broadcastUpdates(result.rows);
  }
  
  return result.rows;
}

// API Routes

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;
    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds required' });
    }
    
    const result = await createHold(seatIds, sessionId);
    
    if (!result.success) {
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflicts: result.conflicts 
      });
    }
    
    // Broadcast updates
    broadcastUpdates(result.seats);
    
    res.status(201).json({
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seats: result.seats
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body;
    
    const result = await confirmHold(holdId, sessionId);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    if (!result.alreadyConfirmed) {
      broadcastUpdates(result.seats);
    }
    
    res.json({ 
      success: true, 
      seats: result.seats,
      alreadyConfirmed: !!result.alreadyConfirmed 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const released = await releaseHold(holdId);
    res.json({ success: true, released: released.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.write('data: {"type":"connected"}\n\n');
  
  sseClients.add(res);
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    await enforceExpiry();
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // every 30 seconds

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);