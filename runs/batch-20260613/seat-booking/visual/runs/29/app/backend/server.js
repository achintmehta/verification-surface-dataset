const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup with file persistence
const db = new PGlite('./pgdata');

// In-memory SSE clients
let sseClients = [];

// Broadcast function for SSE
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.res.write(message);
    } catch (e) {
      sseClients.splice(index, 1);
    }
  });
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
    const releasedSeats = result.rows.map(r => `${r.row_label}${r.seat_number}`);
    console.log('Released expired holds:', releasedSeats);
    broadcast('seats-updated', { action: 'released', seats: result.rows });
  }
  return result.rows;
}

// Initialize database
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
    
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      hold_id TEXT,
      session_id TEXT,
      booked_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Check if seats are seeded
  const countResult = await db.query('SELECT COUNT(*) FROM seats');
  const count = parseInt(countResult.rows[0].count);
  
  if (count === 0) {
    console.log('Seeding seat map: 5 rows x 10 seats');
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rows) {
      for (let seat = 1; seat <= 10; seat++) {
        await db.query(
          'INSERT INTO seats (row_label, seat_number, status) VALUES ($1, $2, $3)',
          [row, seat, 'available']
        );
      }
    }
  }
  
  // Periodic expiry sweep every 5 seconds
  setInterval(async () => {
    await releaseExpiredHolds();
  }, 5000);
}

// Get all seats with effective status
app.get('/api/seats', async (req, res) => {
  await releaseExpiredHolds();
  
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  
  res.json(result.rows);
});

// Create hold
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'seatIds array and sessionId required' });
  }
  
  await releaseExpiredHolds();
  
  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minute TTL
  
  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id, row_label, seat_number, status FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );
    
    const unavailable = checkResult.rows.filter(s => s.status !== 'available');
    
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflictingSeats: unavailable.map(s => s.id) 
      });
    }
    
    // Create hold record
    await db.query(
      'INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)',
      [holdId, sessionId, expiresAt.toISOString()]
    );
    
    // Update seats to held
    for (const seatId of seatIds) {
      await db.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = $3`,
        [holdId, expiresAt.toISOString(), seatId]
      );
    }
    
    await db.exec('COMMIT');
    
    // Broadcast
    broadcast('seats-updated', { action: 'held', holdId, seatIds, sessionId });
    
    res.status(201).json({ 
      holdId, 
      expiresAt: expiresAt.toISOString(),
      seatIds 
    });
    
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// Confirm hold (book)
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  
  await releaseExpiredHolds();
  
  try {
    await db.exec('BEGIN');
    
    // Verify hold
    const holdResult = await db.query(
      'SELECT * FROM holds WHERE id = $1',
      [holdId]
    );
    
    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    const hold = holdResult.rows[0];
    
    // Check expiry
    if (new Date(hold.expires_at) < new Date()) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired' });
    }
    
    // Check ownership if sessionId provided
    if (sessionId && hold.session_id !== sessionId) {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Not your hold' });
    }
    
    // Get seats for this hold
    const seatsResult = await db.query(
      'SELECT id FROM seats WHERE hold_id = $1 AND status = \'held\'',
      [holdId]
    );
    
    if (seatsResult.rows.length === 0) {
      // Already confirmed? Check if booked
      const bookedCheck = await db.query(
        'SELECT id FROM seats WHERE hold_id = $1 AND status = \'booked\'',
        [holdId]
      );
      if (bookedCheck.rows.length > 0) {
        await db.exec('ROLLBACK');
        return res.json({ success: true, message: 'Already booked', bookingId: holdId });
      }
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'No seats in hold' });
    }
    
    const seatIds = seatsResult.rows.map(r => r.id);
    
    // Book them
    for (const seatId of seatIds) {
      await db.query(
        `UPDATE seats SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL WHERE id = $2`,
        [hold.session_id, seatId]
      );
    }
    
    // Record booking
    await db.query(
      'INSERT INTO bookings (hold_id, session_id) VALUES ($1, $2)',
      [holdId, hold.session_id]
    );
    
    // Remove hold
    await db.query('DELETE FROM holds WHERE id = $1', [holdId]);
    
    await db.exec('COMMIT');
    
    broadcast('seats-updated', { action: 'booked', holdId, seatIds, sessionId: hold.session_id });
    
    res.json({ success: true, bookingId: holdId, seatIds });
    
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// Release hold early
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    await db.exec('BEGIN');
    
    const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
    
    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    const seatResult = await db.query(
      'SELECT id FROM seats WHERE hold_id = $1',
      [holdId]
    );
    
    const seatIds = seatResult.rows.map(r => r.id);
    
    await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1`,
      [holdId]
    );
    
    await db.query('DELETE FROM holds WHERE id = $1', [holdId]);
    
    await db.exec('COMMIT');
    
    broadcast('seats-updated', { action: 'released', holdId, seatIds });
    
    res.json({ success: true, releasedSeats: seatIds });
    
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.write('event: connected\ndata: {}\n\n');
  
  const client = { res };
  sseClients.push(client);
  
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);