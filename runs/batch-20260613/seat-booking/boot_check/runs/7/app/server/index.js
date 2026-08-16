import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const db = new PGlite(path.join(__dirname, '..', 'pgdata'));

class Mutex {
  constructor() {
    this.current = Promise.resolve();
  }
  async run(fn) {
    const previous = this.current;
    let release;
    this.current = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const writeMutex = new Mutex();
const sseClients = new Set();

function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by,
  };
}

function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of [...sseClients]) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TEXT,
      booked_by TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      seat_ids TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      booking_id TEXT
    );

    CREATE INDEX IF NOT EXISTS seats_status_idx ON seats(status);
    CREATE INDEX IF NOT EXISTS seats_hold_id_idx ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS holds_status_exp_idx ON holds(status, expires_at);
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    await db.exec('BEGIN');
    try {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n++) {
          const id = `${row}${n}`;
          await db.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [id, row, n, 'available'],
          );
        }
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }
}

async function sweepExpiredHolds({ shouldBroadcast = true } = {}) {
  return writeMutex.run(async () => sweepExpiredHoldsUnlocked({ shouldBroadcast }));
}

async function sweepExpiredHoldsUnlocked({ shouldBroadcast = true } = {}) {
  const now = new Date().toISOString();
  const expiredSeats = await db.query(
    `SELECT id, hold_id
       FROM seats
      WHERE status = 'held'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at <= $1
      ORDER BY id`,
    [now],
  );
  if (expiredSeats.rows.length === 0) return [];

  await db.exec('BEGIN');
  try {
    await db.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= $1`,
      [now],
    );
    await db.query(
      `UPDATE holds
          SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= $1`,
      [now],
    );
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  const seatIds = expiredSeats.rows.map((r) => r.id);
  if (shouldBroadcast) {
    broadcast('seats', { action: 'released', seats: seatIds.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })) });
  }
  return seatIds;
}

async function getSeats() {
  await sweepExpiredHolds();
  const result = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      ORDER BY row_label, seat_number`,
  );
  return result.rows.map(normalizeSeat);
}

function parseSeatIds(seatIds) {
  if (!Array.isArray(seatIds)) return null;
  const cleaned = [...new Set(seatIds.map((id) => String(id).trim()).filter(Boolean))];
  if (cleaned.length === 0) return null;
  return cleaned;
}

function placeholders(values, startAt = 1) {
  return values.map((_, index) => `$${startAt + index}`).join(', ');
}

async function createHold({ seatIds, sessionId }) {
  const ids = parseSeatIds(seatIds);
  if (!ids || !sessionId) {
    const error = new Error('seatIds and sessionId are required');
    error.status = 400;
    throw error;
  }

  return writeMutex.run(async () => {
    await sweepExpiredHoldsUnlocked();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + HOLD_TTL_SECONDS * 1000).toISOString();
    const holdId = crypto.randomUUID();

    await db.exec('BEGIN');
    try {
      const seatRows = await db.query(
        `SELECT id, status
           FROM seats
          WHERE id IN (${placeholders(ids)})
          ORDER BY id`,
        ids,
      );
      const found = new Set(seatRows.rows.map((r) => r.id));
      const conflicts = [
        ...ids.filter((id) => !found.has(id)),
        ...seatRows.rows.filter((r) => r.status !== 'available').map((r) => r.id),
      ];

      if (conflicts.length > 0 || seatRows.rows.length !== ids.length) {
        await db.exec('ROLLBACK');
        const error = new Error('One or more seats are unavailable');
        error.status = 409;
        error.conflicts = [...new Set(conflicts)];
        throw error;
      }

      const update = await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${placeholders(ids, 3)})
            AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId, expiresAt, ...ids],
      );

      if (update.rows.length !== ids.length) {
        await db.exec('ROLLBACK');
        const error = new Error('One or more seats are unavailable');
        error.status = 409;
        error.conflicts = ids;
        throw error;
      }

      await db.query(
        `INSERT INTO holds (id, session_id, status, seat_ids, expires_at, created_at)
         VALUES ($1, $2, 'active', $3, $4, $5)`,
        [holdId, String(sessionId), JSON.stringify(ids), expiresAt, now.toISOString()],
      );
      await db.exec('COMMIT');

      const seats = update.rows.map(normalizeSeat);
      broadcast('seats', { action: 'held', seats });
      return { id: holdId, sessionId: String(sessionId), seatIds: ids, expiresAt, ttlSeconds: HOLD_TTL_SECONDS, seats };
    } catch (error) {
      try { await db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

async function confirmHold(holdId, sessionId) {
  if (!holdId) {
    const error = new Error('holdId is required');
    error.status = 400;
    throw error;
  }

  return writeMutex.run(async () => {
    await sweepExpiredHoldsUnlocked();

    await db.exec('BEGIN');
    try {
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      const hold = holdResult.rows[0];
      if (!hold) {
        await db.exec('ROLLBACK');
        const error = new Error('Unknown hold');
        error.status = 404;
        throw error;
      }
      if (sessionId && String(sessionId) !== hold.session_id) {
        await db.exec('ROLLBACK');
        const error = new Error('Hold belongs to a different session');
        error.status = 403;
        throw error;
      }

      const seatIds = JSON.parse(hold.seat_ids);

      if (hold.status === 'confirmed') {
        const booked = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY id`,
          [holdId],
        );
        await db.exec('COMMIT');
        return { id: hold.id, bookingId: hold.booking_id, sessionId: hold.session_id, seatIds, status: 'confirmed', seats: booked.rows.map(normalizeSeat), idempotent: true };
      }

      if (hold.status !== 'active' || hold.expires_at <= new Date().toISOString()) {
        await db.exec('ROLLBACK');
        const error = new Error('Hold is expired, released, or otherwise not confirmable');
        error.status = 409;
        throw error;
      }

      const seatRows = await db.query(
        `SELECT id, status, hold_id
           FROM seats
          WHERE id IN (${placeholders(seatIds)})
          ORDER BY id`,
        seatIds,
      );
      const ownsAllSeats = seatRows.rows.length === seatIds.length && seatRows.rows.every((s) => s.status === 'held' && s.hold_id === holdId);
      if (!ownsAllSeats) {
        await db.exec('ROLLBACK');
        const error = new Error('Hold no longer owns all requested seats');
        error.status = 409;
        throw error;
      }

      const bookingId = crypto.randomUUID();
      const update = await db.query(
        `UPDATE seats
            SET status = 'booked', hold_expires_at = NULL, booked_by = $1
          WHERE hold_id = $2 AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [hold.session_id, holdId],
      );
      await db.query(
        `UPDATE holds
            SET status = 'confirmed', confirmed_at = $1, booking_id = $2
          WHERE id = $3`,
        [new Date().toISOString(), bookingId, holdId],
      );
      await db.exec('COMMIT');

      const seats = update.rows.map(normalizeSeat);
      broadcast('seats', { action: 'booked', seats });
      return { id: hold.id, bookingId, sessionId: hold.session_id, seatIds, status: 'confirmed', seats, idempotent: false };
    } catch (error) {
      try { await db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

async function releaseHold(holdId, sessionId) {
  if (!holdId) {
    const error = new Error('holdId is required');
    error.status = 400;
    throw error;
  }
  return writeMutex.run(async () => {
    await sweepExpiredHoldsUnlocked();
    await db.exec('BEGIN');
    try {
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      const hold = holdResult.rows[0];
      if (!hold) {
        await db.exec('ROLLBACK');
        const error = new Error('Unknown hold');
        error.status = 404;
        throw error;
      }
      if (sessionId && String(sessionId) !== hold.session_id) {
        await db.exec('ROLLBACK');
        const error = new Error('Hold belongs to a different session');
        error.status = 403;
        throw error;
      }
      if (hold.status !== 'active') {
        await db.exec('COMMIT');
        return { id: holdId, released: false, status: hold.status, seatIds: JSON.parse(hold.seat_ids) };
      }

      const update = await db.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId],
      );
      await db.query(`UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`, [holdId]);
      await db.exec('COMMIT');
      const seats = update.rows.map(normalizeSeat);
      if (seats.length) broadcast('seats', { action: 'released', seats });
      return { id: holdId, released: true, status: 'released', seatIds: JSON.parse(hold.seat_ids), seats };
    } catch (error) {
      try { await db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

async function inventory() {
  await sweepExpiredHolds();
  const result = await db.query(
    `SELECT status, COUNT(*)::int AS count
       FROM seats
      GROUP BY status`,
  );
  const counts = { available: 0, held: 0, booked: 0, total: ROWS.length * SEATS_PER_ROW };
  for (const row of result.rows) counts[row.status] = Number(row.count);
  counts.total = counts.available + counts.held + counts.booked;
  return counts;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getSeats();
    res.json({ seats, inventory: await inventory() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await inventory());
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const hold = await createHold(req.body || {});
    res.status(201).json({ hold });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const confirmation = await confirmHold(req.params.holdId, req.body?.sessionId);
    res.json({ confirmation });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const sessionId = req.body?.sessionId || req.query.sessionId;
    res.json({ hold: await releaseHold(req.params.holdId, sessionId) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', now: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'Internal server error', conflicts: error.conflicts });
});

await initDb();
setInterval(() => sweepExpiredHolds().catch((err) => console.error('expiry sweep failed', err)), 2_000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
