import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 30);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const dataDir = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), 'data', 'pglite');
fs.mkdirSync(path.dirname(dataDir), { recursive: true });
const db = new PGlite(dataDir);

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const clients = new Map();
let nextClientId = 1;
let lock = Promise.resolve();

function runExclusive(fn) {
  const previous = lock;
  let release;
  lock = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function plusSecondsIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'seatIds must be an array');
  const ids = [...new Set(input.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) throw new HttpError(400, 'Choose at least one valid seat');
  if (ids.length > 10) throw new HttpError(400, 'A single hold may contain at most 10 seats');
  return ids;
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim().length < 3) {
    throw new HttpError(400, 'sessionId is required');
  }
  return sessionId.trim();
}

function placeholders(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(', ');
}

function seatRow(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by,
  };
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

async function withTransaction(fn) {
  await query('BEGIN');
  try {
    const result = await fn();
    await query('COMMIT');
    return result;
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE (row_label, seat_number)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
      seat_id INTEGER NOT NULL REFERENCES seats(id),
      PRIMARY KEY (hold_id, seat_id)
    )
  `);

  await query('CREATE INDEX IF NOT EXISTS seats_status_idx ON seats(status)');
  await query('CREATE INDEX IF NOT EXISTS seats_hold_id_idx ON seats(hold_id)');
  await query('CREATE INDEX IF NOT EXISTS holds_status_expires_idx ON holds(status, expires_at)');

  const countResult = await query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(countResult.rows[0].count) === 0) {
    await withTransaction(async () => {
      for (const row of ROWS) {
        for (let number = 1; number <= SEATS_PER_ROW; number += 1) {
          await query('INSERT INTO seats (row_label, seat_number) VALUES ($1, $2)', [row, number]);
        }
      }
    });
  }
}

async function getInventory() {
  const result = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'held')::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  return result.rows[0];
}

async function selectSeatsByIds(ids) {
  if (ids.length === 0) return [];
  const res = await query(
    `SELECT * FROM seats WHERE id IN (${placeholders(ids)}) ORDER BY row_label, seat_number`,
    ids,
  );
  return res.rows.map(seatRow);
}

async function sweepExpiredHolds(at = nowIso()) {
  return withTransaction(async () => {
    const released = await query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at <= $1
       RETURNING *`,
      [at],
    );

    await query(
      `UPDATE holds
       SET status = 'expired'
       WHERE status = 'active' AND expires_at <= $1`,
      [at],
    );

    return released.rows.map(seatRow);
  });
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function broadcastSeatChanges(type, seats, extra = {}) {
  if (!seats || seats.length === 0) return;
  const payload = {
    type,
    seats,
    inventory: await getInventory(),
    at: nowIso(),
    ...extra,
  };
  for (const res of clients.values()) {
    sendSse(res, 'seats', payload);
  }
}

async function enforceExpiryAndBroadcast() {
  const released = await runExclusive(() => sweepExpiredHolds());
  await broadcastSeatChanges('released', released, { reason: 'expired' });
  return released;
}

async function findConflicts(ids) {
  const rows = await selectSeatsByIds(ids);
  const byId = new Map(rows.map((s) => [s.id, s]));
  return ids
    .filter((id) => !byId.has(id) || byId.get(id).status !== 'available')
    .map((id) => byId.get(id) || { id, status: 'missing' });
}

app.get('/api/health', async (_req, res, next) => {
  try {
    res.json({ ok: true, inventory: await getInventory() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    await enforceExpiryAndBroadcast();
    const seats = await query('SELECT * FROM seats ORDER BY row_label, seat_number');
    res.json({ seats: seats.rows.map(seatRow), inventory: await getInventory(), ttlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const ids = normalizeSeatIds(req.body?.seatIds);
    const sessionId = requireSessionId(req.body?.sessionId);
    const holdId = randomUUID();
    const expiresAt = plusSecondsIso(HOLD_TTL_SECONDS);

    const result = await runExclusive(async () => {
      const released = await sweepExpiredHolds();
      let heldSeats = [];
      await withTransaction(async () => {
        await query(
          'INSERT INTO holds (id, session_id, expires_at, status) VALUES ($1, $2, $3, $4)',
          [holdId, sessionId, expiresAt, 'active'],
        );
        const update = await query(
          `UPDATE seats
           SET status = 'held', hold_id = $${ids.length + 1}, hold_expires_at = $${ids.length + 2}, booked_by = NULL
           WHERE id IN (${placeholders(ids)}) AND status = 'available'
           RETURNING *`,
          [...ids, holdId, expiresAt],
        );
        if (update.rows.length !== ids.length) {
          throw new HttpError(409, 'One or more requested seats are no longer available');
        }
        for (const id of ids) {
          await query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)', [holdId, id]);
        }
        heldSeats = update.rows.map(seatRow);
      });
      return { released, heldSeats };
    }).catch(async (err) => {
      if (err instanceof HttpError && err.status === 409) {
        err.details.conflicts = await findConflicts(ids);
      }
      throw err;
    });

    await broadcastSeatChanges('released', result.released, { reason: 'expired' });
    await broadcastSeatChanges('held', result.heldSeats, { holdId, expiresAt });

    res.status(201).json({
      hold: { id: holdId, sessionId, expiresAt, ttlSeconds: HOLD_TTL_SECONDS, seatIds: ids },
      seats: result.heldSeats,
      inventory: await getInventory(),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = requireSessionId(req.body?.sessionId);

    const result = await runExclusive(async () => {
      const released = await sweepExpiredHolds();
      let bookedSeats = [];
      let alreadyConfirmed = false;
      let hold;

      await withTransaction(async () => {
        const holdRes = await query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (holdRes.rows.length === 0) throw new HttpError(404, 'Unknown hold');
        hold = holdRes.rows[0];
        if (hold.session_id !== sessionId) throw new HttpError(403, 'Hold belongs to a different session');

        if (hold.status === 'confirmed') {
          alreadyConfirmed = true;
          const booked = await query(
            `SELECT s.* FROM seats s
             JOIN hold_seats hs ON hs.seat_id = s.id
             WHERE hs.hold_id = $1
             ORDER BY s.row_label, s.seat_number`,
            [holdId],
          );
          bookedSeats = booked.rows.map(seatRow);
          return;
        }

        if (hold.status !== 'active' || new Date(hold.expires_at).getTime() <= Date.now()) {
          throw new HttpError(410, 'Hold has expired or is no longer active');
        }

        const owned = await query(
          `SELECT s.* FROM seats s
           JOIN hold_seats hs ON hs.seat_id = s.id
           WHERE hs.hold_id = $1 AND s.status = 'held' AND s.hold_id = $1
           ORDER BY s.row_label, s.seat_number`,
          [holdId],
        );
        const expected = await query('SELECT COUNT(*)::int AS count FROM hold_seats WHERE hold_id = $1', [holdId]);
        if (owned.rows.length !== Number(expected.rows[0].count)) {
          throw new HttpError(409, 'Hold no longer owns all seats; nothing was booked');
        }

        const update = await query(
          `UPDATE seats
           SET status = 'booked', booked_by = $2, hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING *`,
          [holdId, sessionId],
        );
        if (update.rows.length !== Number(expected.rows[0].count)) {
          throw new HttpError(409, 'Could not confirm all seats; nothing was booked');
        }
        await query(
          `UPDATE holds SET status = 'confirmed', confirmed_at = $2 WHERE id = $1 AND status = 'active'`,
          [holdId, nowIso()],
        );
        bookedSeats = update.rows.map(seatRow);
      });

      return { released, bookedSeats, alreadyConfirmed, hold };
    });

    await broadcastSeatChanges('released', result.released, { reason: 'expired' });
    if (!result.alreadyConfirmed) {
      await broadcastSeatChanges('booked', result.bookedSeats, { holdId });
    }

    res.json({
      booking: { holdId, sessionId, alreadyConfirmed: result.alreadyConfirmed, seatIds: result.bookedSeats.map((s) => s.id) },
      seats: result.bookedSeats,
      inventory: await getInventory(),
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = requireSessionId(req.body?.sessionId);

    const result = await runExclusive(async () => {
      const expired = await sweepExpiredHolds();
      let released = [];
      await withTransaction(async () => {
        const holdRes = await query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (holdRes.rows.length === 0) throw new HttpError(404, 'Unknown hold');
        const hold = holdRes.rows[0];
        if (hold.session_id !== sessionId) throw new HttpError(403, 'Hold belongs to a different session');
        if (hold.status === 'confirmed') throw new HttpError(409, 'Confirmed bookings cannot be released');
        if (hold.status !== 'active') return;

        const update = await query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING *`,
          [holdId],
        );
        await query(`UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`, [holdId]);
        released = update.rows.map(seatRow);
      });
      return { expired, released };
    });

    await broadcastSeatChanges('released', result.expired, { reason: 'expired' });
    await broadcastSeatChanges('released', result.released, { reason: 'manual', holdId });
    res.json({ released: result.released, inventory: await getInventory() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const id = nextClientId++;
  clients.set(id, res);
  sendSse(res, 'hello', { clientId: id, inventory: await getInventory(), ttlSeconds: HOLD_TTL_SECONDS });

  const ping = setInterval(() => sendSse(res, 'ping', { at: nowIso() }), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
  });
});

// Serve a production Vite build when present. API routes above always win.
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error', ...err.details });
});

await initDb();
setInterval(async () => {
  try {
    const released = await enforceExpiryAndBroadcast();
    if (released.length) console.log(`Expired ${released.length} held seat(s)`);
  } catch (err) {
    console.error('expiry sweep failed', err);
  }
}, 1000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
  console.log(`Seat map: ${ROWS.length * SEATS_PER_ROW} seats; hold TTL: ${HOLD_TTL_SECONDS}s`);
});
