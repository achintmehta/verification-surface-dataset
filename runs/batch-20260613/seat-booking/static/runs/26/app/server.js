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

// In-memory SSE clients
let sseClients = [];

// Broadcast function
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(data);
    } catch (e) {
      // Client disconnected
    }
  });
}

// Clean up dead clients periodically
setInterval(() => {
  sseClients = sseClients.filter(client => !client.destroyed);
}, 30000);

// Database initialization
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
  const count = await db.query('SELECT COUNT(*) as count FROM seats');
  if (count.rows[0].count === 0) {
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
    result.rows.forEach(seat => {
      broadcast({
        type: 'seat_update',
        seat: {
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: 'available'
        }
      });
    });
  }
  return result.rows.length;
}

// Get effective status for a seat (considering expiry)
function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at) {
    const expiresAt = new Date(seat.hold_expires_at);
    if (expiresAt < new Date()) {
      return 'available';
    }
  }
  return seat.status;
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
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
      // Don't expose hold details to clients unless needed
    }));
    
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const ttlSeconds = 120; // 2 minutes TTL
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  
  try {
    await releaseExpiredHolds();
    
    // Use transaction for atomicity
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );
    
    const conflictingSeats = [];
    const availableSeats = [];
    
    for (const seat of checkResult.rows) {
      const effectiveStatus = getEffectiveStatus(seat);
      if (effectiveStatus !== 'available') {
        conflictingSeats.push(seat.id);
      } else {
        availableSeats.push(seat.id);
      }
    }
    
    if (conflictingSeats.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflictingSeats 
      });
    }
    
    // All available - acquire them atomically
    if (availableSeats.length > 0) {
      const updatePlaceholders = availableSeats.map((_, i) => `$${i + 1}`).join(',');
      await db.query(
        `UPDATE seats 
         SET status = 'held', hold_id = $${availableSeats.length + 1}, hold_expires_at = $${availableSeats.length + 2}
         WHERE id IN (${updatePlaceholders})`,
        [...availableSeats, holdId, expiresAt]
      );
    }
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    availableSeats.forEach(seatId => {
      const [row, num] = [seatId[0], parseInt(seatId.slice(1))];
      broadcast({
        type: 'seat_update',
        seat: {
          id: seatId,
          row_label: row,
          seat_number: num,
          status: 'held'
        }
      });
    });
    
    res.json({
      hold_id: holdId,
      seat_ids: availableSeats,
      expires_at: expiresAt,
      ttl_seconds: ttlSeconds,
      session_id: sessionId
    });
    
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    await releaseExpiredHolds();
    
    await db.exec('BEGIN');
    
    // Find seats for this hold
    const holdResult = await db.query(
      `SELECT id, row_label, seat_number, status, hold_expires_at, hold_id 
       FROM seats 
       WHERE hold_id = $1`,
      [holdId]
    );
    
    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or already processed' });
    }
    
    // Check if any seat is expired or not held by this hold
    const now = new Date();
    let isValid = true;
    for (const seat of holdResult.rows) {
      if (seat.status !== 'held' || 
          !seat.hold_expires_at || 
          new Date(seat.hold_expires_at) < now) {
        isValid = false;
        break;
      }
    }
    
    if (!isValid) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }
    
    // Book the seats - idempotent: only update if still held by this hold
    const seatIds = holdResult.rows.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    
    const updateResult = await db.query(
      `UPDATE seats 
       SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $2
       WHERE hold_id = $1 AND status = 'held'`,
      [holdId, `session_${holdId}`]  // Use holdId as proxy for session since we don't track it separately
    );
    
    await db.exec('COMMIT');
    
    if (updateResult.rowCount > 0) {
      // Broadcast bookings
      holdResult.rows.forEach(seat => {
        broadcast({
          type: 'seat_update',
          seat: {
            id: seat.id,
            row_label: seat.row_label,
            seat_number: seat.seat_number,
            status: 'booked'
          }
        });
      });
    }
    
    res.json({ 
      success: true, 
      booked_seats: seatIds,
      message: updateResult.rowCount > 0 ? 'Seats booked successfully' : 'Seats already booked'
    });
    
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    await releaseExpiredHolds();
    
    const result = await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1 AND status = 'held'
       RETURNING id, row_label, seat_number`,
      [holdId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hold not found or already released' });
    }
    
    // Broadcast releases
    result.rows.forEach(seat => {
      broadcast({
        type: 'seat_update',
        seat: {
          id: seat.id,
          row_label: seat.row_label,
          seat_number: seat.seat_number,
          status: 'available'
        }
      });
    });
    
    res.json({ success: true, released_seats: result.rows.map(r => r.id) });
    
  } catch (err) {
    console.error('Release error:', err);
    res.status(500).json({ error: 'Release failed' });
  }
});

// GET /api/stream - SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  sseClients.push(res);
  
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Periodic expiry sweep
setInterval(async () => {
  try {
    const released = await releaseExpiredHolds();
    if (released > 0) {
      console.log(`Periodic sweep released ${released} seats`);
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // Every 30 seconds

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite database initialized');
  });
}

start().catch(console.error);