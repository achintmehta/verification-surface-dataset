import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'crypto';

const app = express();
const PORT = 3000;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes
const ROWS = 5;
const SEATS_PER_ROW = 10;

app.use(cors());
app.use(express.json());

// Initialize PGlite
const db = new PGlite('./pgdata');

let sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
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

  // Seed seats if not exists
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const values = [];
    for (let r = 1; r <= ROWS; r++) {
      const rowLabel = String.fromCharCode(64 + r); // A, B, C...
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${rowLabel}${s}`;
        values.push(`('${id}', '${rowLabel}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(', ')}`);
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

async function getEffectiveSeats() {
  await releaseExpiredHolds();
  const { rows } = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return rows.map(row => {
    let effectiveStatus = row.status;
    if (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date()) {
      effectiveStatus = 'available';
    }
    return {
      id: row.id,
      row: row.row_label,
      number: row.seat_number,
      status: effectiveStatus,
      holdId: row.hold_id,
      expiresAt: row.hold_expires_at,
      bookedBy: row.booked_by
    };
  });
}

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getEffectiveSeats();
    res.json({ seats });
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

    const holdId = randomUUID();
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

      // All available, acquire them
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      await tx.query(`
        UPDATE seats 
        SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
        WHERE id IN (${updatePlaceholders})
      `, [...seatIds, holdId, expiresAt]);

      return { success: true, holdId, expiresAt };
    });

    if (!result.success) {
      return res.status(409).json({ error: 'Some seats unavailable', conflictingSeatIds: result.unavailable });
    }

    broadcast('seats-held', { seatIds, holdId, sessionId, expiresAt });
    res.json({ holdId, expiresAt, seatIds });
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
        `SELECT id, status, hold_expires_at FROM seats WHERE hold_id = $1`,
        [holdId]
      );

      if (heldSeats.length === 0) {
        // Check if already booked (idempotency)
        const { rows: bookedSeats } = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1 AND status = 'booked'`,
          [holdId]
        );
        if (bookedSeats.length > 0) {
          return { success: true, alreadyConfirmed: true, seatIds: bookedSeats.map(s => s.id) };
        }
        return { success: false, error: 'Hold not found' };
      }

      // Check expiry
      const now = new Date();
      const expired = heldSeats.some(seat => seat.hold_expires_at && new Date(seat.hold_expires_at) < now);
      if (expired) {
        return { success: false, error: 'Hold expired' };
      }

      const seatIds = heldSeats.map(s => s.id);

      // Confirm: book them
      await tx.query(`
        UPDATE seats 
        SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $2
      `, [holdId, holdId]);

      return { success: true, seatIds };
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    if (!result.alreadyConfirmed) {
      broadcast('seats-booked', { seatIds: result.seatIds, holdId, sessionId });
    }
    res.json({ success: true, seatIds: result.seatIds, alreadyConfirmed: !!result.alreadyConfirmed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;

  try {
    const result = await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      if (rows.length === 0) {
        return { success: false };
      }
      const seatIds = rows.map(r => r.id);
      await tx.query(`
        UPDATE seats 
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1
      `, [holdId]);
      return { success: true, seatIds };
    });

    if (result.success) {
      broadcast('seats-released', { seatIds: result.seatIds });
      res.json({ success: true, released: result.seatIds });
    } else {
      res.status(404).json({ error: 'Hold not found or already released' });
    }
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

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

async function startServer() {
  await initDb();
  // Periodic sweep for expired holds
  setInterval(async () => {
    const released = await releaseExpiredHolds();
    if (released.length > 0) {
      console.log('Periodic release:', released);
    }
  }, 30000);

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);