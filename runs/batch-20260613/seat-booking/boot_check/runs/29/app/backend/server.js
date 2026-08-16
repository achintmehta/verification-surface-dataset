const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite({ dataDir: './.pglite' });

let clients = new Set();

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMP,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Seed seats if not exists
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const rowsLabels = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rowsLabels) {
      for (let seat = 1; seat <= 10; seat++) {
        await db.query(
          'INSERT INTO seats (row_label, seat_number, status) VALUES ($1, $2, $3)',
          [row, seat, 'available']
        );
      }
    }
    console.log('Seeded 50 seats');
  }
}

async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, row_label, seat_number
  `, [now]);
  
  if (result.rows.length > 0) {
    console.log(`Released ${result.rows.length} expired seats`);
    broadcastSeatUpdate(result.rows.map(r => ({
      id: r.id,
      row_label: r.row_label,
      seat_number: r.seat_number,
      status: 'available'
    })));
  }
  return result.rows.length;
}

// Periodic sweep
setInterval(async () => {
  await releaseExpiredHolds();
}, 10000); // every 10 seconds

function broadcastSeatUpdate(seats) {
  const data = JSON.stringify({ type: 'seat-update', seats });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds(); // ensure fresh
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
             WHEN status = 'booked' THEN 'booked'
             ELSE 'available'
           END as effective_status,
           hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return rows.map(r => ({
    id: r.id,
    row_label: r.row_label,
    seat_number: r.seat_number,
    status: r.effective_status,
    hold_id: r.hold_id,
    hold_expires_at: r.hold_expires_at,
    booked_by: r.booked_by
  }));
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

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');
    
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: unavailable } = await db.query(`
      SELECT id, row_label, seat_number FROM seats 
      WHERE id = ANY(ARRAY[${placeholders}]::int[]) 
      AND (status != 'available' OR (status = 'held' AND hold_expires_at > NOW()))
    `, seatIds);

    if (unavailable.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflictingSeats: unavailable.map(s => s.id) 
      });
    }

    // All available, create hold
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

    for (const seatId of seatIds) {
      await db.query(`
        UPDATE seats 
        SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
        WHERE id = $3
      `, [holdId, expiresAt, seatId]);
    }

    await db.exec('COMMIT');

    // Fetch updated seats for broadcast
    const { rows: updatedSeats } = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at 
      FROM seats WHERE hold_id = $1
    `, [holdId]);

    broadcastSeatUpdate(updatedSeats.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: 'held',
      hold_id: s.hold_id,
      hold_expires_at: s.hold_expires_at
    })));

    res.json({ 
      holdId, 
      expiresAt, 
      seatIds,
      sessionId 
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
  const { sessionId } = req.body || {};

  await releaseExpiredHolds();

  try {
    await db.exec('BEGIN');

    // Check if hold exists and valid
    const { rows: holdSeats } = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats 
      WHERE hold_id = $1
    `, [holdId]);

    if (holdSeats.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found or already confirmed/expired' });
    }

    // Check expiry
    const now = new Date();
    const expiresAt = new Date(holdSeats[0].hold_expires_at);
    if (expiresAt < now) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold has expired' });
    }

    // Check if already booked (idempotency)
    const alreadyBooked = holdSeats.every(s => s.status === 'booked');
    if (alreadyBooked) {
      await db.exec('ROLLBACK');
      return res.json({ 
        success: true, 
        message: 'Already confirmed', 
        seatIds: holdSeats.map(s => s.id) 
      });
    }

    // Confirm: book them
    for (const seat of holdSeats) {
      await db.query(`
        UPDATE seats 
        SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $1
        WHERE id = $2
      `, [sessionId || 'anonymous', seat.id]);
    }

    await db.exec('COMMIT');

    // Broadcast
    broadcastSeatUpdate(holdSeats.map(s => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      status: 'booked',
      booked_by: sessionId || 'anonymous'
    })));

    res.json({ 
      success: true, 
      seatIds: holdSeats.map(s => s.id) 
    });
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
    const { rows: released } = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND status = 'held'
      RETURNING id, row_label, seat_number
    `, [holdId]);

    if (released.length > 0) {
      broadcastSeatUpdate(released.map(s => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        status: 'available'
      })));
    }

    res.json({ released: released.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release hold' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('data: {"type":"connected"}\n\n');
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);