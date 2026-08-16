import express from 'express';
import cors from 'cors';
import { initDb, getDb, getHoldTTL } from './db.js';

const app = express();
const PORT = 3000;

// In-memory SSE clients
let sseClients = [];

// Broadcast function
function broadcastSeatUpdate() {
  const data = JSON.stringify({ type: 'seat-update', timestamp: Date.now() });
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (e) {
      // Remove dead client
    }
  });
  // Clean up dead clients
  sseClients = sseClients.filter(c => !c.destroyed);
}

app.use(cors());
app.use(express.json());

// Middleware to release expired holds
async function releaseExpiredHolds() {
  const db = await getDb();
  const now = new Date().toISOString();

  const expired = await db.query(`
    SELECT id, hold_id FROM seats 
    WHERE status = 'held' AND hold_expires_at < $1
  `, [now]);

  if (expired.rows.length > 0) {
    const holdIds = [...new Set(expired.rows.map(r => r.hold_id).filter(Boolean))];

    await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE status = 'held' AND hold_expires_at < $1
    `, [now]);

    if (holdIds.length > 0) {
      broadcastSeatUpdate();
    }
  }
}

app.get('/api/seats', async (req, res) => {
  try {
    await releaseExpiredHolds();
    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, 
        CASE 
          WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
          WHEN status = 'held' THEN 'available'
          ELSE status 
        END as status,
        hold_id,
        hold_expires_at,
        booked_by
      FROM seats 
      ORDER BY row_label, seat_number
    `);

    // Post-process to fix status
    const seats = result.rows.map(row => {
      if (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) <= new Date()) {
        return { ...row, status: 'available', hold_id: null, hold_expires_at: null };
      }
      return row;
    });

    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    await releaseExpiredHolds();
    const db = await getDb();
    const holdId = 'hold-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const expiresAt = new Date(Date.now() + getHoldTTL()).toISOString();

    // Use transaction for atomicity
    await db.exec('BEGIN');

    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(`
      SELECT id, status, hold_expires_at FROM seats 
      WHERE id IN (${placeholders})
    `, seatIds);

    const conflicting = [];
    for (const seat of checkResult.rows) {
      const isExpired = seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date();
      if (seat.status !== 'available' && !isExpired) {
        conflicting.push(seat.id);
      }
    }

    if (conflicting.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeats: conflicting });
    }

    // Acquire all seats
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}, booked_by = NULL
      WHERE id IN (${updatePlaceholders})
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
    try { await (await getDb()).exec('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;

  try {
    await releaseExpiredHolds();
    const db = await getDb();

    await db.exec('BEGIN');

    // Check hold validity
    let holdCheck = await db.query(`
      SELECT id, status, hold_id, hold_expires_at FROM seats 
      WHERE hold_id = $1
    `, [holdId]);

    if (holdCheck.rows.length === 0) {
      // Check for idempotency: already confirmed?
      const bookedCheck = await db.query(`
        SELECT id, status FROM seats WHERE booked_by = $1 AND status = 'booked'
      `, [holdId]);
      if (bookedCheck.rows.length > 0) {
        await db.exec('ROLLBACK');
        return res.json({ success: true, message: 'Already confirmed', holdId });
      }
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const firstSeat = holdCheck.rows[0];
    if (firstSeat.status !== 'held' || (firstSeat.hold_expires_at && new Date(firstSeat.hold_expires_at) <= new Date())) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Hold expired or invalid' });
    }

    // Check if already booked (idempotency)
    const alreadyBooked = holdCheck.rows.every(s => s.status === 'booked');
    if (alreadyBooked) {
      await db.exec('ROLLBACK');
      return res.json({ success: true, message: 'Already confirmed', holdId });
    }

    // Confirm booking
    await db.query(`
      UPDATE seats 
      SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $1
      WHERE hold_id = $2
    `, [holdId, holdId]);  // booked_by = holdId for simplicity, or could use session

    await db.exec('COMMIT');

    broadcastSeatUpdate();

    res.json({ success: true, holdId, bookedSeats: holdCheck.rows.length });
  } catch (err) {
    try { await (await getDb()).exec('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const db = await getDb();

    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
      WHERE hold_id = $1 AND status = 'held'
    `, [holdId]);

    const released = result.affectedRows || result.rows?.length || 0;
    if (released > 0) {
      broadcastSeatUpdate();
    }

    res.json({ success: true, released });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('data: {"type":"connected"}\n\n');

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    await releaseExpiredHolds();
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();