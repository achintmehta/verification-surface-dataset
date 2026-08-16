const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

app.use(cors());
app.use(express.json());

// Initialize PGlite with filesystem persistence
const db = new PGlite('./pgdata');

let sseClients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

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

  // Seed seats if not exists (5 rows x 10 seats)
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
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(', ')}`);
    console.log('Seeded 50 seats');
  }
}

async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);
  
  if (result.rows.length > 0) {
    const releasedIds = result.rows.map(r => r.id);
    console.log('Released expired holds:', releasedIds);
    broadcast({ type: 'seats-released', seatIds: releasedIds });
  }
  return result.rows.length;
}

async function getSeatsWithEffectiveStatus() {
  await releaseExpiredHolds();
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  return rows.map(seat => {
    let effectiveStatus = seat.status;
    if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) {
      effectiveStatus = 'available';
    }
    return {
      ...seat,
      status: effectiveStatus,
      hold_expires_at: seat.hold_expires_at ? new Date(seat.hold_expires_at).toISOString() : null
    };
  });
}

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getSeatsWithEffectiveStatus();
    res.json(seats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    await releaseExpiredHolds();

    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

    // Use transaction for atomicity
    const result = await db.transaction(async (tx) => {
      // Check all seats are available
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkQuery = `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`;
      const { rows: seatRows } = await tx.query(checkQuery, seatIds);

      const unavailable = [];
      for (const seat of seatRows) {
        let isAvailable = seat.status === 'available';
        if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) {
          isAvailable = true;
        }
        if (!isAvailable) {
          unavailable.push(seat.id);
        }
      }

      if (unavailable.length > 0) {
        return { success: false, unavailable };
      }

      // Acquire all
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      await tx.query(`
        UPDATE seats 
        SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
        WHERE id IN (${updatePlaceholders})
      `, [holdId, expiresAt, ...seatIds]);

      return { success: true, holdId, expiresAt };
    });

    if (!result.success) {
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeatIds: result.unavailable });
    }

    const heldSeats = await db.query('SELECT id FROM seats WHERE hold_id = $1', [result.holdId]);
    broadcast({ type: 'seats-held', seatIds: seatIds, holdId: result.holdId, expiresAt: result.expiresAt, sessionId });

    res.json({ holdId: result.holdId, expiresAt: result.expiresAt, seatIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  try {
    await releaseExpiredHolds();

    const result = await db.transaction(async (tx) => {
      // Find seats for this hold
      const { rows: heldSeats } = await tx.query(
        `SELECT id, status, hold_expires_at, booked_by FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        // Check if already booked by this session (idempotency)
        const { rows: booked } = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1 AND status = 'booked' AND hold_id IS NULL LIMIT 1`,
          [sessionId]
        );
        if (booked.length > 0) {
          return { success: true, alreadyBooked: true, seatIds: [] }; // or fetch actual
        }
        return { success: false, error: 'Hold not found or expired' };
      }

      // Check expiry and ownership
      const now = new Date();
      const expired = heldSeats.some(s => s.hold_expires_at && new Date(s.hold_expires_at) < now);
      if (expired) {
        return { success: false, error: 'Hold expired' };
      }

      // Confirm: book them
      const seatIds = heldSeats.map(s => s.id);
      await tx.query(`
        UPDATE seats 
        SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $2
      `, [sessionId, holdId]);

      return { success: true, seatIds };
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Confirmation failed' });
    }

    if (result.seatIds && result.seatIds.length > 0) {
      broadcast({ type: 'seats-booked', seatIds: result.seatIds, sessionId });
    }

    res.json({ success: true, seatIds: result.seatIds || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.transaction(async (tx) => {
      const { rows } = await tx.query(`SELECT id FROM seats WHERE hold_id = $1`, [holdId]);
      if (rows.length === 0) {
        return { success: false };
      }
      const seatIds = rows.map(r => r.id);
      await tx.query(`
        UPDATE seats 
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
        WHERE hold_id = $1
      `, [holdId]);
      return { success: true, seatIds };
    });

    if (!result.success) {
      return res.status(404).json({ error: 'Hold not found' });
    }

    broadcast({ type: 'seats-released', seatIds: result.seatIds });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping or current state? For now just keep open
  req.on('close', () => {
    sseClients.delete(res);
  });
});

async function startServer() {
  await initDb();
  // Periodic sweep every 30s
  setInterval(async () => {
    await releaseExpiredHolds();
  }, 30000);

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);