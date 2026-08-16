const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite instance - persists to local filesystem
let db;
const DATA_DIR = './.pglite-data';

// SSE clients
let sseClients = new Set();

// Seat config
const NUM_ROWS = 5;
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Broadcast seat update
function broadcastSeatUpdate(seat) {
  const payload = JSON.stringify({
    type: 'seat-update',
    seat: seat
  });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function broadcastRefresh() {
  const payload = JSON.stringify({ type: 'seats-refresh' });
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
  db = new PGlite({ dataDir: DATA_DIR });
  
  // Wait for ready
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
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);
  
  // Check if seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0].count;
  
  if (count == 0) {
    console.log('Seeding seat map...');
    const values = [];
    const params = [];
    let paramIdx = 1;
    
    for (let r = 0; r < NUM_ROWS; r++) {
      const rowLabel = String.fromCharCode(65 + r); // A, B, C...
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${rowLabel}${s}`;
        values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2})`);
        params.push(id, rowLabel, s);
        paramIdx += 3;
      }
    }
    
    const insertSql = `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`;
    await db.query(insertSql, params);
    console.log(`Seeded ${NUM_ROWS * SEATS_PER_ROW} seats.`);
  }
  
  // Release any expired holds on startup
  await releaseExpiredHolds();
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
    RETURNING id, row_label, seat_number, status
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds.`);
    for (const seat of result.rows) {
      broadcastSeatUpdate(seat);
    }
  }
  
  return result.rows.length;
}

// Get effective seats (with expiry check)
async function getSeats() {
  await releaseExpiredHolds();
  
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  
  // Map to effective status for client
  return result.rows.map(row => {
    let effectiveStatus = row.status;
    if (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date()) {
      effectiveStatus = 'available';
    }
    return {
      id: row.id,
      row_label: row.row_label,
      seat_number: row.seat_number,
      status: effectiveStatus,
      // Don't expose hold details to client unless owned
    };
  });
}

// Atomic hold acquisition
async function acquireHold(seatIds, sessionId) {
  await releaseExpiredHolds();
  
  const holdId = 'hold_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
  
  // Use transaction for atomicity
  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );
    
    const conflicting = [];
    for (const seat of checkRes.rows) {
      if (seat.status !== 'available' || 
          (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date())) {
        conflicting.push(seat.id);
      }
    }
    
    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return { success: false, conflictingSeats: conflicting };
    }
    
    // All good, acquire
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const updateParams = [holdId, expiresAt, sessionId, ...seatIds];
    
    await db.query(`
      UPDATE seats 
      SET status = 'held', 
          hold_id = $1, 
          hold_expires_at = $2,
          booked_by = $3
      WHERE id IN (${updatePlaceholders})
    `, updateParams);
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    const updatedSeats = await db.query(
      `SELECT id, row_label, seat_number, status, hold_expires_at FROM seats WHERE hold_id = $1`,
      [holdId]
    );
    
    for (const seat of updatedSeats.rows) {
      broadcastSeatUpdate({
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: 'held'
      });
    }
    
    return {
      success: true,
      holdId,
      expiresAt,
      ttlSeconds: Math.floor(HOLD_TTL_MS / 1000),
      seatIds
    };
    
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

// Confirm hold - idempotent and transactional
async function confirmHold(holdId, sessionId) {
  await releaseExpiredHolds();
  
  try {
    await db.exec('BEGIN');
    
    // Find the hold
    const holdRes = await db.query(`
      SELECT hold_id, status, hold_expires_at, booked_by 
      FROM seats 
      WHERE hold_id = $1 
      LIMIT 1
    `, [holdId]);
    
    if (holdRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return { success: false, error: 'Hold not found' };
    }
    
    const firstSeat = holdRes.rows[0];
    
    // Check ownership (optional, but good)
    if (firstSeat.booked_by !== sessionId) {
      // Still allow if same hold? But for simplicity, we check expiry mainly
    }
    
    // Check expiry
    if (firstSeat.hold_expires_at && new Date(firstSeat.hold_expires_at) < new Date()) {
      await db.exec('ROLLBACK');
      return { success: false, error: 'Hold expired', expired: true };
    }
    
    // Check if already booked (idempotency)
    const bookedCheck = await db.query(`
      SELECT COUNT(*) as booked_count FROM seats 
      WHERE hold_id = $1 AND status = 'booked'
    `, [holdId]);
    
    if (bookedCheck.rows[0].booked_count > 0) {
      // Already confirmed, return success idempotently
      const seatIdsRes = await db.query(`SELECT id FROM seats WHERE hold_id = $1`, [holdId]);
      await db.exec('COMMIT');
      return { 
        success: true, 
        seatIds: seatIdsRes.rows.map(r => r.id),
        alreadyBooked: true 
      };
    }
    
    // Confirm: book them
    await db.query(`
      UPDATE seats 
      SET status = 'booked', 
          hold_expires_at = NULL 
      WHERE hold_id = $1 AND status = 'held'
    `, [holdId]);
    
    const seatIdsRes = await db.query(`SELECT id FROM seats WHERE hold_id = $1`, [holdId]);
    const seatIds = seatIdsRes.rows.map(r => r.id);
    
    await db.exec('COMMIT');
    
    // Broadcast
    for (const seatId of seatIds) {
      const seatRes = await db.query(`SELECT id, row_label, seat_number FROM seats WHERE id = $1`, [seatId]);
      if (seatRes.rows[0]) {
        broadcastSeatUpdate({
          id: seatId,
          row_label: seatRes.rows[0].row_label,
          seat_number: seatRes.rows[0].seat_number,
          status: 'booked'
        });
      }
    }
    
    return { success: true, seatIds };
    
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

// Release hold early
async function releaseHold(holdId) {
  await releaseExpiredHolds();
  
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', 
        hold_id = NULL, 
        hold_expires_at = NULL 
    WHERE hold_id = $1 AND status = 'held'
    RETURNING id, row_label, seat_number
  `, [holdId]);
  
  if (result.rows.length > 0) {
    for (const seat of result.rows) {
      broadcastSeatUpdate({
        id: seat.id,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        status: 'available'
      });
    }
  }
  
  return { success: true, released: result.rows.length };
}

// API Routes

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;
    
    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    
    const result = await acquireHold(seatIds, sessionId);
    
    if (!result.success) {
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflictingSeats: result.conflictingSeats 
      });
    }
    
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.body.sessionId || 'unknown';
    
    const result = await confirmHold(holdId, sessionId);
    
    if (!result.success) {
      return res.status(400).json({ 
        error: result.error,
        expired: result.expired 
      });
    }
    
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Release failed' });
  }
});

// GET /api/stream - SSE
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
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
      broadcastRefresh();
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // every 30s

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Frontend: http://localhost:5173`);
  });
}

start().catch(console.error);