const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite instance
let db;
const clients = new Set(); // SSE clients

// TTL in milliseconds (e.g., 2 minutes for demo)
const HOLD_TTL_MS = 2 * 60 * 1000;

async function initDb() {
  db = new PGlite({ dataDir: 'file://./seat-booking-data' });
  
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
  
  // Seed seats if empty (5 rows x 10 seats)
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const values = [];
    for (let row = 1; row <= 5; row++) {
      const rowLabel = String.fromCharCode(64 + row); // A, B, C, D, E
      for (let seatNum = 1; seatNum <= 10; seatNum++) {
        const id = `${rowLabel}${seatNum}`;
        values.push(`('${id}', '${rowLabel}', ${seatNum}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(', ')}`);
    console.log('Seeded 50 seats');
  }
  
  // Initial expiry sweep
  await sweepExpiredHolds();
}

async function sweepExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired holds`);
    broadcastSeatUpdate();
  }
  return result.rows.length;
}

async function getSeatsWithEffectiveStatus() {
  await sweepExpiredHolds();
  
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
             WHEN status = 'held' THEN 'available'
             ELSE status 
           END as status,
           hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  
  return rows.map(row => ({
    id: row.id,
    row_label: row.row_label,
    seat_number: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    expiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  }));
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.write('data: {"type":"connected"}\n\n');
  
  clients.add(res);
  
  req.on('close', () => {
    clients.delete(res);
  });
});

function broadcastSeatUpdate() {
  const data = JSON.stringify({ type: 'seat-update', timestamp: Date.now() });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
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
  
  try {
    await sweepExpiredHolds();
    
    // Use transaction for atomicity
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkQuery = `
      SELECT id FROM seats 
      WHERE id IN (${placeholders}) 
      AND status != 'available'
    `;
    const { rows: unavailable } = await db.query(checkQuery, seatIds);
    
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      const conflicting = unavailable.map(r => r.id);
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }
    
    // Create hold
    const holdId = `hold-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
    
    // Update all seats atomically
    const updateQuery = `
      UPDATE seats 
      SET status = 'held', hold_id = $1, hold_expires_at = $2 
      WHERE id IN (${placeholders})
    `;
    await db.query(updateQuery, [holdId, expiresAt, ...seatIds]);
    
    await db.exec('COMMIT');
    
    broadcastSeatUpdate();
    
    res.json({
      holdId,
      seatIds,
      expiresAt,
      ttlSeconds: Math.floor(HOLD_TTL_MS / 1000)
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    await sweepExpiredHolds();
    
    await db.exec('BEGIN');
    
    // Check if hold exists and is valid
    const { rows: holdSeats } = await db.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE hold_id = $1
    `, [holdId]);
    
    if (holdSeats.length === 0) {
      // Check if already booked by this hold (idempotency)
      const { rows: bookedCheck } = await db.query(`
        SELECT id FROM seats WHERE booked_by = $1
      `, [holdId]);
      
      if (bookedCheck.length > 0) {
        await db.exec('COMMIT');
        return res.json({ success: true, message: 'Already confirmed', seatIds: bookedCheck.map(r => r.id) });
      }
      
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or expired' });
    }
    
    // Verify not expired
    const now = new Date();
    const anyExpired = holdSeats.some(s => new Date(s.hold_expires_at) < now);
    if (anyExpired) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold has expired' });
    }
    
    // Book them
    const seatIds = holdSeats.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $1
    `, [holdId]);
    
    await db.exec('COMMIT');
    
    broadcastSeatUpdate();
    
    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm' });
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
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hold not found or already released' });
    }
    
    broadcastSeatUpdate();
    
    res.json({ success: true, releasedSeats: result.rows.map(r => r.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// Periodic sweep
setInterval(async () => {
  const released = await sweepExpiredHolds();
  if (released > 0) {
    console.log(`Periodic sweep released ${released} seats`);
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