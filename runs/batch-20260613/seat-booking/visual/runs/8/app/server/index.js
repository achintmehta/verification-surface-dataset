import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const dataDir = process.env.PGLITE_DATA_DIR || './data/pglite';
fs.mkdirSync(dataDir, { recursive: true });
const db = new PGlite(dataDir);

let transactionTail = Promise.resolve();
async function withTransaction(fn) {
  const previous = transactionTail;
  let release;
  transactionTail = new Promise((resolve) => (release = resolve));
  await previous;

  try {
    await db.query('BEGIN');
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      // Ignore rollback errors; preserve the original failure.
    }
    throw error;
  } finally {
    release();
  }
}

const clients = new Set();
function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function broadcast(event) {
  const enriched = { ...event, at: new Date().toISOString() };
  for (const res of clients) {
    try {
      sendSse(res, enriched);
    } catch {
      clients.delete(res);
    }
  }
}
function broadcastSeatChanges(seats, status, extra = {}) {
  if (!seats?.length) return;
  broadcast({
    type: 'seatsChanged',
    status,
    seats: seats.map((seat) => ({
      id: Number(seat.id),
      rowLabel: seat.row_label,
      seatNumber: Number(seat.seat_number),
      status,
      holdId: status === 'held' ? seat.hold_id : null,
      holdExpiresAt: status === 'held' ? seat.hold_expires_at : null,
      bookedBy: status === 'booked' ? seat.booked_by : null
    })),
    ...extra
  });
}

function placeholders(values, start = 1) {
  return values.map((_, index) => `$${index + start}`).join(', ');
}
function normalizeSeatIds(seatIds) {
  if (!Array.isArray(seatIds)) return null;
  const ids = [...new Set(seatIds.map((id) => Number(id)))];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) return null;
  return ids;
}
function dbSeatToClient(row) {
  return {
    id: Number(row.id),
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  };
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE(row_label, seat_number)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ NULL,
      released_at TIMESTAMPTZ NULL
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL REFERENCES holds(id),
      seat_id INTEGER NOT NULL REFERENCES seats(id),
      PRIMARY KEY (hold_id, seat_id)
    );
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_status_expiry ON seats(status, hold_expires_at);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);');

  const seeded = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (Number(seeded.rows[0].count) === 0) {
    let id = 1;
    for (const row of ROWS) {
      for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4);',
          [id, row, seatNumber, 'available']
        );
        id += 1;
      }
    }
  }
}

async function sweepExpiredHolds() {
  return withTransaction(async () => {
    const expiredSeats = await db.query(`
      SELECT id, row_label, seat_number, hold_id, hold_expires_at, booked_by
      FROM seats
      WHERE status = 'held' AND hold_expires_at <= now()
      ORDER BY id;
    `);
    if (!expiredSeats.rows.length) return [];

    await db.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at <= now();
    `);
    await db.query(`
      UPDATE holds
      SET status = 'expired', released_at = now()
      WHERE status = 'pending' AND expires_at <= now();
    `);
    return expiredSeats.rows;
  }).then((released) => {
    broadcastSeatChanges(released, 'available', { reason: 'expired' });
    return released;
  });
}

async function getInventorySummary() {
  const result = await db.query(`
    SELECT status, COUNT(*)::int AS count
    FROM seats
    GROUP BY status;
  `);
  const summary = { available: 0, held: 0, booked: 0, total: 0 };
  for (const row of result.rows) {
    summary[row.status] = Number(row.count);
    summary.total += Number(row.count);
  }
  return summary;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, holdTtlSeconds: HOLD_TTL_SECONDS });
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, { type: 'connected', at: new Date().toISOString() });

  req.on('close', () => {
    clients.delete(res);
  });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    await sweepExpiredHolds();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats
      ORDER BY row_label, seat_number;
    `);
    const inventory = await getInventorySummary();
    res.json({ seats: result.rows.map(dbSeatToClient), inventory, holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!seatIds || !sessionId) {
      return res.status(400).json({ error: 'seatIds (non-empty array) and sessionId are required' });
    }

    await sweepExpiredHolds();
    const result = await withTransaction(async () => {
      const selectSql = `
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM seats
        WHERE id IN (${placeholders(seatIds)})
        ORDER BY id;
      `;
      const selected = await db.query(selectSql, seatIds);
      const found = new Set(selected.rows.map((row) => Number(row.id)));
      const conflicts = selected.rows
        .filter((row) => row.status !== 'available')
        .map((row) => Number(row.id));
      for (const id of seatIds) {
        if (!found.has(id)) conflicts.push(id);
      }
      if (conflicts.length) {
        return { ok: false, conflicts: [...new Set(conflicts)].sort((a, b) => a - b) };
      }

      const holdId = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
      await db.query(
        'INSERT INTO holds (id, session_id, status, expires_at) VALUES ($1, $2, $3, $4);',
        [holdId, sessionId, 'pending', expiresAt]
      );
      for (const id of seatIds) {
        await db.query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2);', [holdId, id]);
      }
      const updateSql = `
        UPDATE seats
        SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
        WHERE id IN (${placeholders(seatIds, 3)}) AND status = 'available'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
      `;
      const updated = await db.query(updateSql, [holdId, expiresAt, ...seatIds]);
      if (updated.rows.length !== seatIds.length) {
        throw new Error('Concurrent acquisition failed; no seats were booked, please retry.');
      }
      return { ok: true, hold: { id: holdId, sessionId, seatIds, expiresAt }, seats: updated.rows };
    });

    if (!result.ok) {
      return res.status(409).json({ error: 'One or more seats are unavailable', conflictingSeatIds: result.conflicts });
    }

    broadcastSeatChanges(result.seats, 'held', { holdId: result.hold.id, expiresAt: result.hold.expiresAt });
    return res.status(201).json({ hold: result.hold });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId) return res.status(400).json({ error: 'holdId is required' });

    await sweepExpiredHolds();
    const result = await withTransaction(async () => {
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
      if (!holdResult.rows.length) return { ok: false, code: 404, error: 'Unknown hold' };
      const hold = holdResult.rows[0];
      if (sessionId && hold.session_id !== sessionId) return { ok: false, code: 403, error: 'Hold belongs to another session' };

      const seatResult = await db.query(`
        SELECT s.id, s.row_label, s.seat_number, s.status, s.hold_id, s.hold_expires_at, s.booked_by
        FROM hold_seats hs
        JOIN seats s ON s.id = hs.seat_id
        WHERE hs.hold_id = $1
        ORDER BY s.id;
      `, [holdId]);
      const seatIds = seatResult.rows.map((row) => Number(row.id));

      if (hold.status === 'confirmed') {
        return {
          ok: true,
          idempotent: true,
          booking: { holdId, sessionId: hold.session_id, seatIds, confirmedAt: hold.confirmed_at }
        };
      }
      if (hold.status !== 'pending') return { ok: false, code: 409, error: `Hold is ${hold.status}` };

      const expiry = new Date(hold.expires_at).getTime();
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        await db.query('UPDATE holds SET status = $2, released_at = now() WHERE id = $1 AND status = $3;', [holdId, 'expired', 'pending']);
        return { ok: false, code: 409, error: 'Hold has expired' };
      }

      const invalidSeats = seatResult.rows.filter((row) => row.status !== 'held' || row.hold_id !== holdId);
      if (invalidSeats.length || seatIds.length === 0) {
        return { ok: false, code: 409, error: 'Hold no longer owns all of its seats' };
      }

      const updateSql = `
        UPDATE seats
        SET status = 'booked', hold_id = NULL, booked_by = $1, hold_expires_at = NULL
        WHERE hold_id = $2 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
      `;
      const booked = await db.query(updateSql, [hold.session_id, holdId]);
      await db.query('UPDATE holds SET status = $2, confirmed_at = now() WHERE id = $1;', [holdId, 'confirmed']);
      const confirmed = await db.query('SELECT confirmed_at FROM holds WHERE id = $1;', [holdId]);
      return {
        ok: true,
        idempotent: false,
        seats: booked.rows,
        booking: { holdId, sessionId: hold.session_id, seatIds, confirmedAt: confirmed.rows[0]?.confirmed_at }
      };
    });

    if (!result.ok) return res.status(result.code || 400).json({ error: result.error });
    if (!result.idempotent) broadcastSeatChanges(result.seats, 'booked', { holdId });
    return res.json({ booking: result.booking, idempotent: result.idempotent });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!holdId) return res.status(400).json({ error: 'holdId is required' });

    await sweepExpiredHolds();
    const result = await withTransaction(async () => {
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
      if (!holdResult.rows.length) return { ok: false, code: 404, error: 'Unknown hold' };
      const hold = holdResult.rows[0];
      if (sessionId && hold.session_id !== sessionId) return { ok: false, code: 403, error: 'Hold belongs to another session' };
      if (hold.status !== 'pending') return { ok: true, seats: [], already: hold.status };

      const released = await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
      `, [holdId]);
      await db.query('UPDATE holds SET status = $2, released_at = now() WHERE id = $1;', [holdId, 'released']);
      return { ok: true, seats: released.rows, already: null };
    });

    if (!result.ok) return res.status(result.code || 400).json({ error: result.error });
    broadcastSeatChanges(result.seats, 'available', { holdId, reason: 'released' });
    return res.json({ releasedSeatIds: result.seats.map((seat) => Number(seat.id)), already: result.already });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

await initDb();
setInterval(() => {
  sweepExpiredHolds().catch((error) => console.error('expiry sweep failed', error));
}, 1000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
