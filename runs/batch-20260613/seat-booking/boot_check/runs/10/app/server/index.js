import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT || 3000;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const dataDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
mkdirSync(dataDir, { recursive: true });
const db = new PGlite(dataDir);

// A small in-process mutex keeps multi-statement PGLite transactions from being
// interleaved by Express request handlers. The database still enforces state with
// conditional updates; this makes the all-or-nothing flow deterministic on the
// embedded single-process server.
let lockTail = Promise.resolve();
async function withDbLock(fn) {
  const previous = lockTail;
  let release;
  lockTail = new Promise((resolve) => (release = resolve));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

const sseClients = new Set();

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

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

async function computeInventoryUnsafe() {
  const now = new Date().toISOString();
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'available' OR (status = 'held' AND hold_expires_at <= $1))::int AS available,
       COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > $1)::int AS held,
       COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
     FROM seats`,
    [now],
  );
  return result.rows[0] || { total: 0, available: 0, held: 0, booked: 0 };
}

async function broadcast(action, seats, extra = {}) {
  if (!seats || seats.length === 0) return;
  const payload = {
    action,
    seats: seats.map(normalizeSeat),
    inventory: await computeInventoryUnsafe(),
    ...extra,
  };
  for (const client of sseClients) {
    sendSse(client, 'seat-update', payload);
  }
}

function placeholders(values, start = 1) {
  return values.map((_, index) => `$${start + index}`).join(', ');
}

function assertValidSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.status = 400;
    throw err;
  }
  const unique = [...new Set(seatIds.map(String))];
  if (unique.length !== seatIds.length) {
    const err = new Error('seatIds must not contain duplicates');
    err.status = 400;
    throw err;
  }
  if (unique.length > ROWS.length * SEATS_PER_ROW) {
    const err = new Error('too many seats requested');
    err.status = 400;
    throw err;
  }
  return unique;
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('held', 'booked', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      booked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT REFERENCES holds(id),
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE (row_label, seat_number),
      CHECK (
        (status = 'available' AND booked_by IS NULL)
        OR status = 'held'
        OR status = 'booked'
      )
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_expires_at ON seats(hold_expires_at);
    CREATE INDEX IF NOT EXISTS idx_holds_status_expires_at ON holds(status, expires_at);
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    await db.query('BEGIN');
    try {
      for (const row of ROWS) {
        for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
          const id = `${row}-${seatNumber}`;
          await db.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')`,
            [id, row, seatNumber],
          );
        }
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }
}

async function sweepExpiredHoldsUnsafe() {
  const now = new Date().toISOString();
  await db.query('BEGIN');
  try {
    const released = await db.query(
      `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at <= $1
       RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
      [now],
    );
    await db.query(
      `UPDATE holds
       SET status = 'expired'
       WHERE status = 'held' AND expires_at <= $1`,
      [now],
    );
    await db.query('COMMIT');
    if (released.rows.length) {
      await broadcast('released', released.rows, { reason: 'expired' });
    }
    return released.rows;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function getAllSeatsUnsafe() {
  const result = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
     FROM seats
     ORDER BY row_label, seat_number`,
  );
  return result.rows.map(normalizeSeat);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  sendSse(res, 'connected', { ok: true, ttlSeconds: HOLD_TTL_SECONDS });

  const heartbeat = setInterval(() => sendSse(res, 'ping', { at: new Date().toISOString() }), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const payload = await withDbLock(async () => {
      await sweepExpiredHoldsUnsafe();
      return {
        seats: await getAllSeatsUnsafe(),
        inventory: await computeInventoryUnsafe(),
        ttlSeconds: HOLD_TTL_SECONDS,
      };
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = assertValidSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) {
      const err = new Error('sessionId is required');
      err.status = 400;
      throw err;
    }

    const response = await withDbLock(async () => {
      await sweepExpiredHoldsUnsafe();

      const inList = placeholders(seatIds);
      const existing = await db.query(`SELECT id FROM seats WHERE id IN (${inList})`, seatIds);
      const found = new Set(existing.rows.map((row) => row.id));
      const missing = seatIds.filter((id) => !found.has(id));
      if (missing.length) {
        const err = new Error(`unknown seat id(s): ${missing.join(', ')}`);
        err.status = 400;
        throw err;
      }

      await db.query('BEGIN');
      try {
        const conflicts = await db.query(
          `SELECT id FROM seats WHERE id IN (${inList}) AND status <> 'available' ORDER BY id`,
          seatIds,
        );
        if (conflicts.rows.length) {
          await db.query('ROLLBACK');
          const err = new Error('one or more seats are unavailable');
          err.status = 409;
          err.conflictingSeatIds = conflicts.rows.map((row) => row.id);
          throw err;
        }

        const holdId = randomUUID();
        const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
        await db.query(
          `INSERT INTO holds (id, session_id, expires_at, status)
           VALUES ($1, $2, $3, 'held')`,
          [holdId, sessionId, expiresAt],
        );

        const updateParams = [holdId, expiresAt, ...seatIds];
        const held = await db.query(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
           WHERE id IN (${placeholders(seatIds, 3)}) AND status = 'available'
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          updateParams,
        );

        if (held.rows.length !== seatIds.length) {
          await db.query('ROLLBACK');
          const err = new Error('one or more seats are unavailable');
          err.status = 409;
          err.conflictingSeatIds = seatIds;
          throw err;
        }

        await db.query('COMMIT');
        await broadcast('held', held.rows, { holdId, expiresAt, sessionId });
        return {
          hold: {
            id: holdId,
            sessionId,
            seatIds,
            expiresAt,
            ttlSeconds: HOLD_TTL_SECONDS,
            status: 'held',
          },
          seats: held.rows.map(normalizeSeat),
          inventory: await computeInventoryUnsafe(),
        };
      } catch (error) {
        try { await db.query('ROLLBACK'); } catch {}
        throw error;
      }
    });

    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();

    const response = await withDbLock(async () => {
      await sweepExpiredHoldsUnsafe();
      await db.query('BEGIN');
      try {
        const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (!holdResult.rows.length) {
          await db.query('ROLLBACK');
          const err = new Error('unknown hold');
          err.status = 404;
          throw err;
        }
        const hold = holdResult.rows[0];
        if (sessionId && hold.session_id !== sessionId) {
          await db.query('ROLLBACK');
          const err = new Error('hold belongs to another session');
          err.status = 403;
          throw err;
        }

        if (hold.status === 'booked') {
          const bookedSeats = await db.query(
            `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY row_label, seat_number`,
            [holdId],
          );
          await db.query('COMMIT');
          return {
            booking: {
              holdId,
              sessionId: hold.session_id,
              seatIds: bookedSeats.rows.map((row) => row.id),
              status: 'booked',
              idempotent: true,
            },
            seats: bookedSeats.rows.map(normalizeSeat),
            inventory: await computeInventoryUnsafe(),
          };
        }

        if (hold.status !== 'held' || new Date(hold.expires_at).getTime() <= Date.now()) {
          await db.query('ROLLBACK');
          const err = new Error('hold is not active');
          err.status = 409;
          throw err;
        }

        const owned = await db.query(
          `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY row_label, seat_number`,
          [holdId],
        );
        if (!owned.rows.length) {
          await db.query('ROLLBACK');
          const err = new Error('hold owns no active seats');
          err.status = 409;
          throw err;
        }

        const booked = await db.query(
          `UPDATE seats
           SET status = 'booked', hold_expires_at = NULL, booked_by = $2
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId, hold.session_id],
        );
        await db.query(
          `UPDATE holds SET status = 'booked', booked_at = $2 WHERE id = $1`,
          [holdId, new Date().toISOString()],
        );
        await db.query('COMMIT');
        await broadcast('booked', booked.rows, { holdId, sessionId: hold.session_id });
        return {
          booking: {
            holdId,
            sessionId: hold.session_id,
            seatIds: booked.rows.map((row) => row.id),
            status: 'booked',
            idempotent: false,
          },
          seats: booked.rows.map(normalizeSeat),
          inventory: await computeInventoryUnsafe(),
        };
      } catch (error) {
        try { await db.query('ROLLBACK'); } catch {}
        throw error;
      }
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();

    const response = await withDbLock(async () => {
      await sweepExpiredHoldsUnsafe();
      await db.query('BEGIN');
      try {
        const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (!holdResult.rows.length) {
          await db.query('ROLLBACK');
          const err = new Error('unknown hold');
          err.status = 404;
          throw err;
        }
        const hold = holdResult.rows[0];
        if (sessionId && hold.session_id !== sessionId) {
          await db.query('ROLLBACK');
          const err = new Error('hold belongs to another session');
          err.status = 403;
          throw err;
        }
        if (hold.status !== 'held') {
          await db.query('COMMIT');
          return { released: false, reason: hold.status, seats: [], inventory: await computeInventoryUnsafe() };
        }

        const released = await db.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId],
        );
        await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
        await db.query('COMMIT');
        await broadcast('released', released.rows, { holdId, reason: 'manual' });
        return {
          released: true,
          seats: released.rows.map(normalizeSeat),
          inventory: await computeInventoryUnsafe(),
        };
      } catch (error) {
        try { await db.query('ROLLBACK'); } catch {}
        throw error;
      }
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const payload = { error: err.message || 'Internal Server Error' };
  if (err.conflictingSeatIds) payload.conflictingSeatIds = err.conflictingSeatIds;
  if (status >= 500) console.error(err);
  res.status(status).json(payload);
});

await initDb();
setInterval(() => {
  withDbLock(() => sweepExpiredHoldsUnsafe()).catch((error) => console.error('expiry sweep failed', error));
}, 1000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
