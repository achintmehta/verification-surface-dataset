import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

app.use(cors());
app.use(express.json());

// Initialize PGLite with file persistence
const db = new PGlite('./pglite-data');

let sseClients = new Set();

function broadcastSeatUpdate() {
  const data = JSON.stringify({ type: 'seat-update', timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

async function initDatabase() {
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
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const rowsLabels = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    for (const row of rowsLabels) {
      for (let seat = 1; seat <= 10; seat++) {
        const id = `${row}${seat}`;
        values.push(`('${id}', '${row}', ${seat}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(', ')}
    `);
    console.log('Seeded 50 seats');
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
    console.log(`Released ${result.rows.length} expired holds`);
    broadcastSeatUpdate();
  }
  return result.rows.length;
}

async function getEffectiveSeats() {
  await releaseExpiredHolds();
  
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
    seat_number: parseInt(row.seat_number),
    status: row.status,
    hold_id: row.hold_id,
    hold_expires_at: row.hold_expires_at,
    booked_by: row.booked_by
  }));
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getEffectiveSeats();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// POST /api/holds - atomic all-or-nothing hold
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await releaseExpiredHolds();

  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(`
      SELECT id FROM seats 
      WHERE id = ANY(ARRAY[${placeholders}]) 
        AND status != 'available'
    `, seatIds);
    
    if (checkResult.rows.length > 0) {
      await db.exec('ROLLBACK');
      const conflicting = checkResult.rows.map(r => r.id);
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflictingSeats: conflicting 
      });
    }

    // Atomically acquire all
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
      WHERE id = ANY(ARRAY[${updatePlaceholders}])
    `, [...seatIds, holdId, expiresAt]);

    await db.exec('COMMIT');
    
    broadcastSeatUpdate();
    
    res.json({
      id: holdId,
      seatIds,
      sessionId,
      expires_at: expiresAt
    });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to acquire hold' });
  }
});

// POST /api/holds/:holdId/confirm - idempotent confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Check if already booked by this hold (idempotency)
    const alreadyBooked = await db.query(`
      SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked'
    `, [holdId]);
    
    if (alreadyBooked.rows.length > 0) {
      await db.exec('COMMIT');
      return res.json({ success: true, message: 'Already confirmed' });
    }

    // Validate hold: exists, not expired, owned
    const now = new Date().toISOString();
    const holdCheck = await db.query(`
      SELECT COUNT(*) as count FROM seats 
      WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > $2
    `, [holdId, now]);
    
    if (parseInt(holdCheck.rows[0].count) === 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired, invalid, or not found' });
    }

    // Book them
    await db.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $2 AND status = 'held'
    `, [sessionId, holdId]);

    await db.exec('COMMIT');
    broadcastSeatUpdate();
    
    res.json({ success: true, message: 'Seats booked successfully' });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// DELETE /api/holds/:holdId - release hold early
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
      broadcastSeatUpdate();
    }
    
    res.json({ released: result.rows.length });
  } catch (err) {
    console.error('Release error:', err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// GET /api/stream - SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.add(res);

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic expiry sweep
setInterval(async () => {
  await releaseExpiredHolds();
}, 30000);

async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite data persisted to ./pglite-data');
  });
}

startServer().catch(console.error);