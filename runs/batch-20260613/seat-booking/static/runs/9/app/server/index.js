import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);

const db = new PGlite(path.join(__dirname, '..', 'pgdata'));
const app = express();
const clients = new Set();
let dbLock = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: '64kb' }));

// PGlite runs embedded in this process. Serializing API handlers keeps multi-query
// transactions from interleaving while the SQL statements themselves still use
// conditional updates for atomic all-or-nothing seat acquisition.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api') || req.path === '/api/stream') return next();

  const previous = dbLock;
  let release;
  dbLock = new Promise((resolve) => {
    release = resolve;
  });

  try {
    await previous;
    const unlock = () => release();
    res.once('finish', unlock);
    res.once('close', unlock);
    return next();
  } catch (error) {
    release();
    return next(error);
  }
});

function nowIso() {
  return new Date().toISOString();
}

function expiresIso() {
  return new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
}

function sendJson(res, status, body) {
  return res.status(status).json(body);
}

function makePlaceholders(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(', ');
}

function normalizeSeatIds(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((id) => String(id || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

function publicSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  };
}

function holdPayload(row, seats) {
  return {
    holdId: row.hold_id,
    sessionId: row.session_id,
    status: row.status,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    bookingId: row.booking_id,
    seats
  };
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

function broadcastSeats(event, rows) {
  const seats = rows.map(publicSeat);
  if (seats.length > 0) broadcast(event, { seats });
}

async function query(sql, params = []) {
  return db.query(sql, params);
}


async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS holds (
      hold_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('held', 'booked', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      booking_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT REFERENCES holds(hold_id),
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE (row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL)
      )
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_expires_at ON seats(hold_expires_at);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_holds_expires_at ON holds(expires_at);`);

  const countResult = await query('SELECT COUNT(*)::int AS count FROM seats;');
  if (Number(countResult.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
        await query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4);',
          [`${row}${seatNumber}`, row, seatNumber, 'available']
        );
      }
    }
  }
}

async function sweepExpiredHolds({ shouldBroadcast = true } = {}) {
  const expiredSeatsResult = await query(`
    UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
     WHERE status = 'held'
       AND hold_expires_at <= now()
     RETURNING *;
  `);

  await query(`
    UPDATE holds
       SET status = 'expired'
     WHERE status = 'held'
       AND expires_at <= now();
  `);

  const released = expiredSeatsResult.rows || [];
  if (shouldBroadcast && released.length > 0) broadcastSeats('released', released);
  return released;
}

async function getAllSeats() {
  await sweepExpiredHolds();
  const result = await query(`
    SELECT *
      FROM seats
     ORDER BY row_label, seat_number;
  `);
  return result.rows.map(publicSeat);
}

async function getInventory() {
  await sweepExpiredHolds();
  const result = await query(`
    SELECT status, COUNT(*)::int AS count
      FROM seats
     GROUP BY status;
  `);
  const inventory = { available: 0, held: 0, booked: 0, total: 0 };
  for (const row of result.rows) {
    inventory[row.status] = Number(row.count);
    inventory.total += Number(row.count);
  }
  return inventory;
}

async function conflictingSeats(seatIds) {
  const placeholders = makePlaceholders(seatIds);
  const result = await query(
    `SELECT id, status FROM seats WHERE id IN (${placeholders}) ORDER BY id;`,
    seatIds
  );
  const seen = new Set(result.rows.map((row) => row.id));
  const conflicts = result.rows.filter((row) => row.status !== 'available').map((row) => row.id);
  for (const id of seatIds) {
    if (!seen.has(id)) conflicts.push(id);
  }
  return conflicts;
}

app.get('/api/health', async (_req, res, next) => {
  try {
    res.json({ ok: true, inventory: await getInventory() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getAllSeats();
    const inventory = { available: 0, held: 0, booked: 0, total: seats.length };
    for (const seat of seats) inventory[seat.status] += 1;
    res.json({ seats, inventory, holdTtlSeconds: HOLD_TTL_SECONDS, serverTime: nowIso() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  const seatIds = normalizeSeatIds(req.body?.seatIds);
  const sessionId = String(req.body?.sessionId || '').trim();

  if (!seatIds || seatIds.length === 0) return sendJson(res, 400, { error: 'seatIds must be a non-empty array' });
  if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });

  const holdId = randomUUID();
  const expiresAt = expiresIso();

  try {
    await sweepExpiredHolds();
    await query('BEGIN;');
    try {
      const holdResult = await query(
        `INSERT INTO holds (hold_id, session_id, status, expires_at)
         VALUES ($1, $2, 'held', $3)
         RETURNING *;`,
        [holdId, sessionId, expiresAt]
      );

      const placeholders = makePlaceholders(seatIds, 3);
      const updateResult = await query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${placeholders})
            AND status = 'available'
          RETURNING *;`,
        [holdId, expiresAt, ...seatIds]
      );

      if (updateResult.rows.length !== seatIds.length) {
        await query('ROLLBACK;');
        const conflicts = await conflictingSeats(seatIds);
        return sendJson(res, 409, { error: 'One or more seats are unavailable', conflictingSeatIds: conflicts });
      }

      await query('COMMIT;');

      const seats = updateResult.rows.map(publicSeat).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      broadcast('held', { holdId, sessionId, expiresAt, seats });
      return sendJson(res, 201, { hold: holdPayload(holdResult.rows[0], seats), serverTime: nowIso() });
    } catch (error) {
      await query('ROLLBACK;').catch(() => {});
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  const holdId = String(req.params.holdId || '').trim();
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });

  try {
    await sweepExpiredHolds();
    await query('BEGIN;');
    try {
      const holdResult = await query('SELECT * FROM holds WHERE hold_id = $1;', [holdId]);
      if (holdResult.rows.length === 0) {
        await query('ROLLBACK;');
        return sendJson(res, 404, { error: 'Unknown hold' });
      }

      const hold = holdResult.rows[0];
      if (hold.session_id !== sessionId) {
        await query('ROLLBACK;');
        return sendJson(res, 403, { error: 'Hold belongs to another session' });
      }

      if (hold.status === 'booked') {
        const bookedSeats = await query('SELECT * FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY row_label, seat_number;', [holdId, 'booked']);
        await query('COMMIT;');
        return res.json({ hold: holdPayload(hold, bookedSeats.rows.map(publicSeat)), idempotent: true, serverTime: nowIso() });
      }

      if (hold.status !== 'held' || new Date(hold.expires_at).getTime() <= Date.now()) {
        await query('ROLLBACK;');
        return sendJson(res, 409, { error: 'Hold is expired, released, or otherwise not confirmable' });
      }

      const heldSeatsResult = await query(
        `SELECT * FROM seats
          WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now()
          ORDER BY row_label, seat_number;`,
        [holdId]
      );
      if (heldSeatsResult.rows.length === 0) {
        await query('ROLLBACK;');
        return sendJson(res, 409, { error: 'Hold has no active seats' });
      }

      const bookingId = randomUUID();
      const bookedResult = await query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2, hold_expires_at = NULL
          WHERE hold_id = $1
            AND status = 'held'
            AND hold_expires_at > now()
          RETURNING *;`,
        [holdId, sessionId]
      );

      if (bookedResult.rows.length !== heldSeatsResult.rows.length) {
        await query('ROLLBACK;');
        return sendJson(res, 409, { error: 'Hold could not be confirmed atomically' });
      }

      const updatedHoldResult = await query(
        `UPDATE holds
            SET status = 'booked', confirmed_at = now(), booking_id = $2
          WHERE hold_id = $1
          RETURNING *;`,
        [holdId, bookingId]
      );
      await query('COMMIT;');

      const seats = bookedResult.rows.map(publicSeat);
      broadcast('booked', { holdId, sessionId, bookingId, seats });
      return res.json({ hold: holdPayload(updatedHoldResult.rows[0], seats), idempotent: false, serverTime: nowIso() });
    } catch (error) {
      await query('ROLLBACK;').catch(() => {});
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  const holdId = String(req.params.holdId || '').trim();
  const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });

  try {
    await sweepExpiredHolds();
    await query('BEGIN;');
    try {
      const holdResult = await query('SELECT * FROM holds WHERE hold_id = $1;', [holdId]);
      if (holdResult.rows.length === 0) {
        await query('ROLLBACK;');
        return sendJson(res, 404, { error: 'Unknown hold' });
      }
      const hold = holdResult.rows[0];
      if (hold.session_id !== sessionId) {
        await query('ROLLBACK;');
        return sendJson(res, 403, { error: 'Hold belongs to another session' });
      }
      if (hold.status === 'booked') {
        await query('ROLLBACK;');
        return sendJson(res, 409, { error: 'Booked holds cannot be released' });
      }
      if (hold.status !== 'held') {
        await query('COMMIT;');
        return res.json({ released: [], holdId, status: hold.status });
      }

      const releasedResult = await query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING *;`,
        [holdId]
      );
      await query(`UPDATE holds SET status = 'released' WHERE hold_id = $1;`, [holdId]);
      await query('COMMIT;');

      const seats = releasedResult.rows.map(publicSeat);
      broadcast('released', { holdId, seats });
      return res.json({ holdId, released: seats, serverTime: nowIso() });
    } catch (error) {
      await query('ROLLBACK;').catch(() => {});
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ serverTime: nowIso() })}\n\n`);
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: err?.message });
});

await initDb();
setInterval(async () => {
  const previous = dbLock;
  let release;
  dbLock = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    await sweepExpiredHolds();
  } catch (error) {
    console.error('expiry sweep failed', error);
  } finally {
    release();
  }
}, 1000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
