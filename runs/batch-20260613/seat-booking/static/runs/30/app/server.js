import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setTimeout as sleep } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const SSE_CLIENTS = new Set();
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

let db;

async function initDb() {
  db = new PGlite(join(__dirname, 'seat_booking.db'));
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

  // Seed seats if not exists (5 rows x 10 seats)
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const values = [];
    for (let row = 1; row <= 5; row++) {
      const rowLabel = String.fromCharCode(64 + row); // A, B, C, D, E
      for (let seat = 1; seat <= 10; seat++) {
        const id = `${rowLabel}${seat}`;
        values.push(`('${id}', '${rowLabel}', ${seat}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(', ')}`);
  }
}

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of SSE_CLIENTS) {
    client.write(message);
  }
}

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
    broadcast('seats-released', { seatIds: releasedIds });
    return releasedIds;
  }
  return [];
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
             WHEN status = 'held' THEN 'available'
             ELSE status 
           END as effective_status,
           hold_id, hold_expires_at, booked_by
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  return rows.map(row => ({
    id: row.id,
    row: row.row_label,
    number: row.seat_number,
    status: row.effective_status,
    holdId: row.hold_id,
    expiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  }));
}

app.use(cors());
app.use(express.json());

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  res.write('retry: 10000\n\n');
  SSE_CLIENTS.add(res);
  
  // Send initial seats
  getSeatsWithEffectiveStatus().then(seats => {
    res.write(`event: seats-update\ndata: ${JSON.stringify({ seats })}\n\n`);
  });
  
  req.on('close', () => {
    SSE_CLIENTS.delete(res);
  });
});

// Get all seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json({ seats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create hold
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  try {
    await releaseExpiredHolds();
    
    // Use transaction for atomicity
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: unavailable } = await db.query(`
      SELECT id FROM seats 
      WHERE id IN (${placeholders}) 
      AND (status != 'available' OR (status = 'held' AND hold_expires_at > NOW()))
    `, seatIds);
    
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflictingSeatIds: unavailable.map(r => r.id) 
      });
    }
    
    // Create hold
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
    
    // Update seats to held
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
      WHERE id IN (${updatePlaceholders})
    `, [...seatIds, holdId, expiresAt]);
    
    await db.exec('COMMIT');
    
    const hold = {
      id: holdId,
      seatIds,
      sessionId,
      expiresAt
    };
    
    broadcast('seats-held', { seatIds, holdId, expiresAt });
    
    res.status(201).json({ hold });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Confirm hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  
  try {
    await releaseExpiredHolds();
    
    await db.exec('BEGIN');
    
    // Check hold validity - find seats with this hold_id that are not expired
    const { rows: heldSeats } = await db.query(`
      SELECT id FROM seats 
      WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW()
    `, [holdId]);
    
    if (heldSeats.length === 0) {
      // Check if already booked (idempotency)
      const { rows: bookedSeats } = await db.query(`
        SELECT id, booked_by FROM seats 
        WHERE hold_id = $1 AND status = 'booked'
      `, [holdId]);
      
      if (bookedSeats.length > 0) {
        await db.exec('COMMIT');
        return res.json({ 
          success: true, 
          message: 'Already confirmed',
          seatIds: bookedSeats.map(s => s.id),
          bookedBy: bookedSeats[0].booked_by 
        });
      }
      
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold not found or expired' });
    }
    
    const seatIds = heldSeats.map(r => r.id);
    
    // Book them
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_expires_at = NULL
      WHERE hold_id = $2
    `, [sessionId, holdId]);
    
    await db.exec('COMMIT');
    
    broadcast('seats-booked', { seatIds, bookedBy: sessionId });
    
    res.json({ 
      success: true, 
      seatIds,
      bookedBy: sessionId 
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Release hold
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
      const releasedIds = result.rows.map(r => r.id);
      broadcast('seats-released', { seatIds: releasedIds });
    }
    
    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    const released = await releaseExpiredHolds();
    if (released.length > 0) {
      console.log(`Released expired holds: ${released.join(', ')}`);
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}, 30000); // every 30 seconds

// Initialize and start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});