import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

// PGLite instance - persists to local filesystem
const db = new PGlite('file://./pglite-data');

let sseClients = new Set();

// Broadcast seat status changes to all connected SSE clients
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
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
    broadcast('seats-released', { seats: result.rows.map(r => r.id) });
  }
  return result.rows;
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

  // Check if seats already seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(countRes.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (const row of rows) {
      for (let num = 1; num <= seatsPerRow; num++) {
        const id = `${row}${num}`;
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(id, row, num);
      }
    }

    await db.query(`
      INSERT INTO seats (id, row_label, seat_number) 
      VALUES ${values.join(', ')}
    `, params);
    console.log('Seeded 50 seats');
  }
}

// Get all seats with effective status (release expired first)
async function getAllSeats() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

// Atomic hold acquisition - all or nothing
async function createHold(seatIds, sessionId) {
  await releaseExpiredHolds();
  
  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL

  return await db.transaction(async (tx) => {
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkRes = await tx.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE id IN (${placeholders})
    `, seatIds);

    const unavailable = [];
    for (const seat of checkRes.rows) {
      const isHeldValid = seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > new Date();
      if (seat.status !== 'available' && !isHeldValid) {
        unavailable.push(seat.id);
      }
    }

    if (unavailable.length > 0) {
      return { success: false, conflicts: unavailable };
    }

    // Acquire all seats
    for (const seatId of seatIds) {
      await tx.query(`
        UPDATE seats 
        SET status = 'held', hold_id = $1, hold_expires_at = $2 
        WHERE id = $3 AND status = 'available'
      `, [holdId, expiresAt, seatId]);
    }

    return { 
      success: true, 
      holdId, 
      expiresAt, 
      seatIds 
    };
  });
}

// Confirm hold - idempotent
async function confirmHold(holdId, sessionId) {
  await releaseExpiredHolds();

  return await db.transaction(async (tx) => {
    // Find seats for this hold
    const holdRes = await tx.query(`
      SELECT id, status, hold_expires_at, booked_by 
      FROM seats 
      WHERE hold_id = $1
    `, [holdId]);

    if (holdRes.rows.length === 0) {
      return { success: false, error: 'Hold not found' };
    }

    // Check if already booked (idempotency)
    const alreadyBooked = holdRes.rows.every(s => s.status === 'booked');
    if (alreadyBooked) {
      return { 
        success: true, 
        message: 'Already confirmed', 
        seatIds: holdRes.rows.map(s => s.id) 
      };
    }

    // Check expiry and ownership
    const now = new Date();
    const expired = holdRes.rows.some(s => 
      s.hold_expires_at && new Date(s.hold_expires_at) < now
    );

    if (expired) {
      return { success: false, error: 'Hold expired' };
    }

    // Book them
    await tx.query(`
      UPDATE seats 
      SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $2
    `, [sessionId, holdId]);

    const bookedSeats = holdRes.rows.map(s => s.id);
    return { 
      success: true, 
      seatIds: bookedSeats 
    };
  });
}

// Release hold early
async function releaseHold(holdId) {
  await releaseExpiredHolds();

  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE hold_id = $1 AND status = 'held'
    RETURNING id
  `, [holdId]);

  if (result.rows.length > 0) {
    broadcast('seats-released', { seats: result.rows.map(r => r.id) });
  }

  return result.rows.length > 0;
}

app.use(cors());
app.use(express.json());

// API Routes
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const result = await createHold(seatIds, sessionId);
    
    if (!result.success) {
      return res.status(409).json({ 
        error: 'Some seats unavailable', 
        conflicts: result.conflicts 
      });
    }

    // Broadcast hold
    broadcast('seats-held', { 
      seats: result.seatIds, 
      holdId: result.holdId,
      expiresAt: result.expiresAt 
    });

    res.json({ 
      holdId: result.holdId, 
      expiresAt: result.expiresAt, 
      seatIds: result.seatIds 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hold creation failed' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  try {
    const result = await confirmHold(holdId, sessionId);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    if (result.message === 'Already confirmed') {
      return res.json({ success: true, message: result.message, seatIds: result.seatIds });
    }

    // Broadcast booking
    broadcast('seats-booked', { 
      seats: result.seatIds,
      bookedBy: sessionId 
    });

    res.json({ success: true, seatIds: result.seatIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    const released = await releaseHold(holdId);
    if (released) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Hold not found or already released' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Release failed' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    await releaseExpiredHolds();
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // every 30s

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);