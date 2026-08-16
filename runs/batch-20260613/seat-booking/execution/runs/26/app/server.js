const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite instance - persists to local disk
const db = new PGlite('./seat_booking_db');

// SSE clients
let sseClients = [];

// Broadcast function
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(data);
    } catch (e) {
      // client disconnected
    }
  });
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
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0].count;
  
  if (count == 0) {
    // Seed 5 rows x 10 seats
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    const params = [];
    let paramIndex = 1;
    
    for (const row of rows) {
      for (let seatNum = 1; seatNum <= 10; seatNum++) {
        const id = `${row}${seatNum}`;
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(id, row, seatNum);
      }
    }
    
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
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
    RETURNING id, row_label, seat_number
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    // Broadcast releases
    for (const seat of result.rows) {
      broadcast({
        type: 'seat-update',
        seat: { ...seat, status: 'available' }
      });
    }
  }
  return result.rows.length;
}

// Get effective status for a seat (considering expiry)
function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at) {
    if (new Date(seat.hold_expires_at) < new Date()) {
      return 'available';
    }
  }
  return seat.status;
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  await releaseExpiredHolds();
  
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  
  const seats = result.rows.map(seat => ({
    id: seat.id,
    row_label: seat.row_label,
    seat_number: seat.seat_number,
    status: getEffectiveStatus(seat),
    // Don't expose hold details to clients unless their own
  }));
  
  res.json(seats);
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  await releaseExpiredHolds();
  
  const holdId = 'hold_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minute TTL
  
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
      const effective = getEffectiveStatus(seat);
      if (effective !== 'available') {
        conflicting.push(seat.id);
      }
    }
    
    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ conflictingSeats: conflicting });
    }
    
    // All good, acquire them
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(',');
    const updateParams = [holdId, expiresAt.toISOString(), ...seatIds];
    
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = $2 
      WHERE id IN (${updatePlaceholders})
    `, updateParams);
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    for (const seatId of seatIds) {
      broadcast({
        type: 'seat-update',
        seat: {
          id: seatId,
          status: 'held'
        }
      });
    }
    
    res.json({
      holdId,
      seatIds,
      expiresAt: expiresAt.getTime()
    });
    
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  
  await releaseExpiredHolds();
  
  try {
    await db.exec('BEGIN');
    
    // Find seats for this hold
    const seatsRes = await db.query(
      `SELECT id, status, hold_expires_at, hold_id FROM seats WHERE hold_id = $1`,
      [holdId]
    );
    
    if (seatsRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or already confirmed' });
    }
    
    // Check if any expired
    let allValid = true;
    for (const seat of seatsRes.rows) {
      if (getEffectiveStatus(seat) !== 'held' || seat.hold_id !== holdId) {
        allValid = false;
        break;
      }
    }
    
    if (!allValid) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }
    
    // Confirm: book them
    const seatIds = seatsRes.rows.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    
    await db.query(`
      UPDATE seats 
      SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $1 
      WHERE id IN (${placeholders})
    `, [holdId, ...seatIds]);  // use holdId as booked_by for simplicity
    
    await db.exec('COMMIT');
    
    // Broadcast
    for (const seatId of seatIds) {
      broadcast({
        type: 'seat-update',
        seat: {
          id: seatId,
          status: 'booked'
        }
      });
    }
    
    res.json({ success: true, bookedSeats: seatIds });
    
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id
    `, [holdId]);
    
    if (result.rows.length > 0) {
      for (const row of result.rows) {
        broadcast({
          type: 'seat-update',
          seat: { id: row.id, status: 'available' }
        });
      }
    }
    
    res.json({ released: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error releasing hold' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  sseClients.push(res);
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  const released = await releaseExpiredHolds();
  if (released > 0) {
    // Already broadcasted inside
  }
}, 30000); // every 30 seconds

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);