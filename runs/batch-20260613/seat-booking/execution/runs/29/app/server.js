const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// PGLite instance - persist to local filesystem
const db = new PGlite('./seat-booking-data');

let clients = []; // SSE clients

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
  const count = await db.query('SELECT COUNT(*) as count FROM seats');
  if (count.rows[0].count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    for (const row of rows) {
      for (let num = 1; num <= seatsPerRow; num++) {
        const id = `${row}${num}`;
        values.push(`('${id}', '${row}', ${num}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(', ')}
    `);
    console.log('Seeded 50 seats');
  }
}

// Release expired holds
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

// Get effective status for a seat (considering expiry)
async function getSeats() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

// Broadcast seat status changes via SSE
function broadcastSeatUpdate(seatIds, status, extra = {}) {
  const data = JSON.stringify({ seatIds, status, ...extra, timestamp: Date.now() });
  clients.forEach((client, index) => {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (e) {
      clients.splice(index, 1);
    }
  });
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('\n');

  const client = { id: Date.now(), res };
  clients.push(client);

  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

// Middleware
app.use(cors());
app.use(express.json());

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeats();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  await releaseExpiredHolds();

  const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL

  try {
    await db.exec('BEGIN');

    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkResult = await db.query(
      `SELECT id, status FROM seats WHERE id IN (${placeholders})`,
      seatIds
    );

    const unavailable = checkResult.rows.filter(r => r.status !== 'available');
    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'Some seats unavailable',
        conflictingSeats: unavailable.map(r => r.id)
      });
    }

    // Atomically hold them
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `UPDATE seats 
       SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
       WHERE id IN (${updatePlaceholders})`,
      [...seatIds, holdId, expiresAt]
    );

    await db.exec('COMMIT');

    broadcastSeatUpdate(seatIds, 'held', { holdId, expiresAt, sessionId });

    res.json({ holdId, expiresAt, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
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
      `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const now = new Date();
    const expired = holdResult.rows.some(r => new Date(r.hold_expires_at) < now);
    if (expired) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired' });
    }

    // Check if already booked (idempotency)
    const alreadyBooked = holdResult.rows.every(r => r.status === 'booked');
    if (alreadyBooked) {
      await db.exec('COMMIT');
      const seatIds = holdResult.rows.map(r => r.id);
      return res.json({ success: true, seatIds, message: 'Already confirmed' });
    }

    // Confirm: book them
    const seatIds = holdResult.rows.map(r => r.id);
    await db.query(
      `UPDATE seats 
       SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $2`,
      [sessionId, holdId]
    );

    await db.exec('COMMIT');

    broadcastSeatUpdate(seatIds, 'booked', { sessionId });

    res.json({ success: true, seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    await db.exec('BEGIN');

    const result = await db.query(
      `SELECT id FROM seats WHERE hold_id = $1`,
      [holdId]
    );

    if (result.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    const seatIds = result.rows.map(r => r.id);
    await db.query(
      `UPDATE seats 
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE hold_id = $1`,
      [holdId]
    );

    await db.exec('COMMIT');

    broadcastSeatUpdate(seatIds, 'available');

    res.json({ success: true, releasedSeats: seatIds });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// Periodic sweep for expired holds
setInterval(async () => {
  await releaseExpiredHolds();
}, 30000); // every 30 seconds

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);