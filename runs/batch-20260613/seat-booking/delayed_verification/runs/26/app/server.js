import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup - persist to local disk
const db = new PGlite(join(__dirname, 'pgdata'));

// SSE clients
let sseClients = new Set();

// Broadcast function
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(data);
    } catch (e) {
      sseClients.delete(client);
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

// Initialize database
async function initDB() {
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

  // Create holds table for tracking
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed BOOLEAN DEFAULT FALSE
    );
  `);

  // Seed seats if empty (5 rows x 10 seats)
  const count = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(count.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    const params = [];
    let paramIdx = 1;
    
    for (const row of rows) {
      for (let seatNum = 1; seatNum <= 10; seatNum++) {
        const id = `${row}${seatNum}`;
        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
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

// Get effective status (considering expiry)
async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  
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
      hold_id: effectiveStatus === 'held' ? row.hold_id : null,
      booked_by: row.booked_by
    };
  });
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
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
  
  const holdId = 'hold_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const ttlMs = 2 * 60 * 1000; // 2 minutes TTL
  const expiresAt = new Date(Date.now() + ttlMs);
  
  try {
    await db.exec('BEGIN');
    
    // First, release any expired holds
    const now = new Date().toISOString();
    await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE status = 'held' AND hold_expires_at < $1
    `, [now]);
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );
    
    const conflicting = [];
    for (const seat of checkResult.rows) {
      const isExpired = seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date();
      if (seat.status !== 'available' && !isExpired) {
        conflicting.push(seat.id);
      }
    }
    
    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ conflictingSeats: conflicting });
    }
    
    // Create hold record
    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, sessionId, expiresAt.toISOString()]
    );
    
    // Update seats to held
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2} 
       WHERE id IN (${updatePlaceholders})`,
      [...seatIds, holdId, expiresAt.toISOString()]
    );
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    for (const seatId of seatIds) {
      broadcast({
        type: 'seat-update',
        seat: {
          id: seatId,
          status: 'held',
          hold_id: holdId
        }
      });
    }
    
    res.json({
      id: holdId,
      seatIds,
      sessionId,
      expires_at: expiresAt.getTime(),
      ttl: ttlMs
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to acquire hold' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    await db.exec('BEGIN');
    
    // Release expired first
    const now = new Date().toISOString();
    await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE status = 'held' AND hold_expires_at < $1
    `, [now]);
    
    // Get hold
    const holdResult = await db.query(
      'SELECT * FROM holds WHERE id = $1',
      [holdId]
    );
    
    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    const hold = holdResult.rows[0];
    
    if (hold.confirmed) {
      // Idempotent: already confirmed, return existing booking
      const bookedSeats = await db.query(
        'SELECT id FROM seats WHERE hold_id = $1 AND status = $2',
        [holdId, 'booked']
      );
      await db.exec('COMMIT');
      return res.json({
        id: 'booking_' + holdId,
        holdId,
        seatIds: bookedSeats.rows.map(r => r.id),
        message: 'Already confirmed'
      });
    }
    
    if (new Date(hold.expires_at) < new Date()) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired', expired: true });
    }
    
    // Get seats for this hold
    const seatsResult = await db.query(
      'SELECT id FROM seats WHERE hold_id = $1 AND status = $2',
      [holdId, 'held']
    );
    
    if (seatsResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'No seats in hold' });
    }
    
    const seatIds = seatsResult.rows.map(r => r.id);
    
    // Mark as booked
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `UPDATE seats SET status = 'booked', hold_expires_at = NULL, booked_by = $1 
       WHERE id IN (${updatePlaceholders})`,
      [hold.session_id, ...seatIds]
    );
    
    // Mark hold confirmed
    await db.query(
      'UPDATE holds SET confirmed = TRUE WHERE id = $1',
      [holdId]
    );
    
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
    
    res.json({
      id: 'booking_' + holdId,
      holdId,
      seatIds
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
    await db.exec('BEGIN');
    
    const seatsResult = await db.query(
      'SELECT id FROM seats WHERE hold_id = $1',
      [holdId]
    );
    
    if (seatsResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or already released' });
    }
    
    const seatIds = seatsResult.rows.map(r => r.id);
    
    await db.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
       WHERE hold_id = $1`,
      [holdId]
    );
    
    await db.exec('COMMIT');
    
    // Broadcast releases
    for (const seatId of seatIds) {
      broadcast({
        type: 'seat-update',
        seat: {
          id: seatId,
          status: 'available'
        }
      });
    }
    
    res.json({ released: seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Release error:', err);
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
  
  sseClients.add(res);
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic expiry sweep
setInterval(async () => {
  try {
    const released = await releaseExpiredHolds();
    if (released > 0) {
      // Also broadcast full update occasionally
      const seats = await getSeatsWithEffectiveStatus();
      broadcast({ type: 'seats-update', seats });
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // Every 30 seconds

// Start server
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite initialized with seat map');
  });
}

start().catch(console.error);