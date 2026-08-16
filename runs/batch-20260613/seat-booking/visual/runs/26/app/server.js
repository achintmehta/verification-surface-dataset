const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// PGLite instance - persists to local filesystem
const db = new PGlite('./seat-booking-data');

let sseClients = [];

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
      hold_expires_at TIMESTAMP,
      booked_by TEXT
    );
  `);

  // Check if seats are seeded
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = result.rows[0].count;
  
  if (count === 0) {
    // Seed 5 rows x 10 seats
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    const params = [];
    let paramIndex = 1;
    
    for (const row of rows) {
      for (let seatNum = 1; seatNum <= 10; seatNum++) {
        const id = `${row}${seatNum}`;
        values.push(`($${paramIndex}, $${paramIndex+1}, $${paramIndex+2})`);
        params.push(id, row, seatNum);
        paramIndex += 3;
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
    RETURNING id
  `, [now]);
  
  if (result.rows.length > 0) {
    const releasedIds = result.rows.map(r => r.id);
    console.log('Released expired holds:', releasedIds);
    broadcastSeatUpdate(releasedIds, 'available');
  }
  return result.rows.length;
}

// Broadcast seat status changes via SSE
function broadcastSeatUpdate(seatIds, status, extra = {}) {
  const eventData = JSON.stringify({ seatIds, status, ...extra, timestamp: Date.now() });
  sseClients.forEach(client => {
    client.write(`data: ${eventData}\n\n`);
  });
}

// Get effective status for a seat (considering expiry)
function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) {
    return 'available';
  }
  return seat.status;
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  await releaseExpiredHolds();
  
  const result = await db.query('SELECT * FROM seats ORDER BY row_label, seat_number');
  const seats = result.rows.map(seat => ({
    id: seat.id,
    row_label: seat.row_label,
    seat_number: seat.seat_number,
    status: getEffectiveStatus(seat),
    // Don't expose hold details to clients unless owned
  }));
  
  // Calculate inventory
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  
  res.json({ seats, inventory: { available, held, booked, total: seats.length } });
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  await releaseExpiredHolds();
  
  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minute TTL
  
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
      const effectiveStatus = getEffectiveStatus(seat);
      if (effectiveStatus !== 'available') {
        unavailable.push(seat.id);
      }
    }
    
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: unavailable });
    }
    
    // Acquire all seats atomically
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const updateParams = [holdId, expiresAt.toISOString(), ...seatIds];
    
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = $2 
      WHERE id IN (${updatePlaceholders})
    `, updateParams);
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    broadcastSeatUpdate(seatIds, 'held', { holdId, expiresAt: expiresAt.toISOString(), sessionId });
    
    res.json({ 
      holdId, 
      expiresAt: expiresAt.toISOString(), 
      seatIds,
      ttl: 120000 // ms
    });
    
  } catch (error) {
    await db.exec('ROLLBACK');
    console.error('Hold error:', error);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  
  await releaseExpiredHolds();
  
  try {
    await db.exec('BEGIN');
    
    // Find seats for this hold
    const holdResult = await db.query(
      `SELECT id, status, hold_expires_at, booked_by FROM seats WHERE hold_id = $1`,
      [holdId]
    );
    
    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    // Check if already booked (idempotency)
    const alreadyBooked = holdResult.rows.every(seat => seat.status === 'booked');
    if (alreadyBooked) {
      await db.exec('ROLLBACK');
      const seatIds = holdResult.rows.map(s => s.id);
      return res.json({ success: true, message: 'Already confirmed', seatIds, bookedBy: holdResult.rows[0].booked_by });
    }
    
    // Check expiry and ownership
    const now = new Date();
    const expired = holdResult.rows.some(seat => 
      seat.hold_expires_at && new Date(seat.hold_expires_at) < now
    );
    
    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold has expired' });
    }
    
    // Confirm: book the seats
    const seatIds = holdResult.rows.map(s => s.id);
    const updateParams = [sessionId || 'anonymous', ...seatIds];
    const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
      WHERE id IN (${placeholders})
    `, updateParams);
    
    await db.exec('COMMIT');
    
    broadcastSeatUpdate(seatIds, 'booked', { bookedBy: sessionId || 'anonymous' });
    
    res.json({ success: true, seatIds, bookedBy: sessionId || 'anonymous' });
    
  } catch (error) {
    await db.exec('ROLLBACK');
    console.error('Confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  await releaseExpiredHolds();
  
  try {
    const result = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id`,
      [holdId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hold not found or already released' });
    }
    
    const releasedIds = result.rows.map(r => r.id);
    broadcastSeatUpdate(releasedIds, 'available');
    
    res.json({ success: true, releasedSeats: releasedIds });
    
  } catch (error) {
    console.error('Release error:', error);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  sseClients.push(res);
  
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Periodic sweep for expired holds (every 30 seconds)
setInterval(async () => {
  const released = await releaseExpiredHolds();
  if (released > 0) {
    console.log(`Periodic sweep released ${released} seats`);
  }
}, 30000);

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite database initialized with seat map');
  });
}

start().catch(console.error);