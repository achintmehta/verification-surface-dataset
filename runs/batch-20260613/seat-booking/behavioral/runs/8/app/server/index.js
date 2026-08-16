import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite');

const db = new PGlite(DB_PATH);
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const clients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function isoNowPlus(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function normalizeSeat(row) {
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

function broadcast(event, payload) {
  const data = JSON.stringify({ event, ...payload });
  for (const client of [...clients]) {
    try {
      client.write(`event: ${event}\n`);
      client.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TEXT,
      booked_by TEXT,
      booked_at TEXT,
      UNIQUE(row_label, seat_number),
      CHECK ((status = 'held') = (hold_id IS NOT NULL AND hold_expires_at IS NOT NULL))
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_expires ON seats(hold_expires_at);`);
  await query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      booking_id TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      confirmed_at TEXT
    );
  `);

  const count = await query(`SELECT COUNT(*)::int AS count FROM seats;`);
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
        await query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available') ON CONFLICT DO NOTHING;`,
          [`${row}${n}`, row, n]
        );
      }
    }
  }
}

async function expireHolds({ shouldBroadcast = true } = {}) {
  return enqueueWrite(async () => {
    let releasedSeatIds = [];
    try {
      const released = await query(
        `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE status = 'held' AND hold_expires_at <= $1
         RETURNING id, hold_id;`,
        [new Date().toISOString()]
      );
      releasedSeatIds = released.rows.map((r) => r.id);
      const staleHoldIds = [...new Set(released.rows.map((r) => r.hold_id).filter(Boolean))];
      if (staleHoldIds.length) {
        await query(
          `UPDATE holds SET status = 'expired'
           WHERE status = 'active' AND id = ANY($1);`,
          [staleHoldIds]
        );
      }
      await query('COMMIT;');
    } catch (err) {
      await query('ROLLBACK;');
      throw err;
    }
    if (releasedSeatIds.length === 0) return [];

    if (shouldBroadcast) {
      broadcast('seats-changed', {
        reason: 'expired',
        seats: releasedSeatIds.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })),
      });
    }
    return releasedSeatIds;
  });
}

async function getSeats({ sweep = true } = {}) {
  if (sweep) await expireHolds();
  const result = await query(`SELECT * FROM seats ORDER BY row_label, seat_number;`);
  return result.rows.map(normalizeSeat);
}

async function getInventory({ sweep = true } = {}) {
  if (sweep) await expireHolds();
  const result = await query(`
    SELECT status, COUNT(*)::int AS count
    FROM seats
    GROUP BY status;
  `);
  const inventory = { total: ROWS.length * SEATS_PER_ROW, available: 0, held: 0, booked: 0 };
  for (const row of result.rows) inventory[row.status] = Number(row.count);
  return inventory;
}

function validateSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.status = 400;
    throw err;
  }
  const ids = [...new Set(seatIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length !== seatIds.length) {
    const err = new Error('seatIds must be unique and non-empty');
    err.status = 400;
    throw err;
  }
  return ids;
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
    await expireHolds();
    const [seats, inventory] = await Promise.all([getSeats({ sweep: false }), getInventory({ sweep: false })]);
    res.json({ seats, inventory, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ event: 'connected' })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = validateSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    await expireHolds();

    const hold = await enqueueWrite(async () => {
      const holdId = crypto.randomUUID();
      const expiresAt = isoNowPlus(HOLD_TTL_MS);
      await query('BEGIN;');
      try {
        const existing = await query(
          `SELECT id, status, hold_expires_at FROM seats WHERE id = ANY($1) ORDER BY id;`,
          [seatIds]
        );
        const found = new Set(existing.rows.map((r) => r.id));
        const missing = seatIds.filter((id) => !found.has(id));
        const conflicts = existing.rows
          .filter((r) => r.status !== 'available')
          .map((r) => r.id)
          .concat(missing);
        if (conflicts.length > 0 || existing.rows.length !== seatIds.length) {
          await query('ROLLBACK;');
          const err = new Error('One or more seats are unavailable');
          err.status = 409;
          err.conflictingSeatIds = [...new Set(conflicts)].sort();
          throw err;
        }

        const updated = await query(
          `UPDATE seats
              SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL, booked_at = NULL
            WHERE id = ANY($3) AND status = 'available'
            RETURNING *;`,
          [holdId, expiresAt, seatIds]
        );
        if (updated.rows.length !== seatIds.length) {
          await query('ROLLBACK;');
          const err = new Error('One or more seats are unavailable');
          err.status = 409;
          err.conflictingSeatIds = seatIds;
          throw err;
        }

        await query(
          `INSERT INTO holds (id, session_id, seat_ids, expires_at, status) VALUES ($1, $2, $3, $4, 'active');`,
          [holdId, sessionId, JSON.stringify(seatIds), expiresAt]
        );
        await query('COMMIT;');
        return {
          id: holdId,
          sessionId,
          seatIds,
          expiresAt,
          status: 'active',
          seats: updated.rows.map(normalizeSeat),
        };
      } catch (err) {
        try { await query('ROLLBACK;'); } catch {}
        throw err;
      }
    });

    broadcast('seats-changed', {
      reason: 'held',
      holdId: hold.id,
      seats: hold.seats.map((s) => ({ id: s.id, status: 'held', holdId: hold.id, holdExpiresAt: hold.expiresAt })),
    });
    res.status(201).json({ hold });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    await expireHolds();
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || '').trim();

    const booking = await enqueueWrite(async () => {
      await query('BEGIN;');
      try {
        const holdResult = await query(`SELECT * FROM holds WHERE id = $1;`, [holdId]);
        if (holdResult.rows.length === 0) {
          await query('ROLLBACK;');
          const err = new Error('Unknown hold');
          err.status = 404;
          throw err;
        }
        const hold = holdResult.rows[0];
        if (sessionId && hold.session_id !== sessionId) {
          await query('ROLLBACK;');
          const err = new Error('Hold belongs to another session');
          err.status = 403;
          throw err;
        }
        const seatIds = JSON.parse(hold.seat_ids);

        if (hold.status === 'confirmed') {
          const seats = await query(`SELECT * FROM seats WHERE id = ANY($1) ORDER BY id;`, [seatIds]);
          await query('COMMIT;');
          return {
            id: hold.booking_id,
            holdId,
            sessionId: hold.session_id,
            seatIds,
            status: 'confirmed',
            idempotent: true,
            seats: seats.rows.map(normalizeSeat),
          };
        }

        if (hold.status !== 'active' || hold.expires_at <= new Date().toISOString()) {
          await query('ROLLBACK;');
          const err = new Error('Hold is expired or no longer active');
          err.status = 409;
          throw err;
        }

        const owned = await query(
          `SELECT * FROM seats WHERE id = ANY($1) AND status = 'held' AND hold_id = $2 AND hold_expires_at = $3 ORDER BY id;`,
          [seatIds, holdId, hold.expires_at]
        );
        if (owned.rows.length !== seatIds.length) {
          await query('ROLLBACK;');
          const err = new Error('Hold no longer owns all requested seats');
          err.status = 409;
          throw err;
        }

        const bookingId = crypto.randomUUID();
        const booked = await query(
          `UPDATE seats
              SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $1, booked_at = $2
            WHERE id = ANY($3) AND status = 'held' AND hold_id = $4
            RETURNING *;`,
          [hold.session_id, new Date().toISOString(), seatIds, holdId]
        );
        if (booked.rows.length !== seatIds.length) {
          await query('ROLLBACK;');
          const err = new Error('Unable to book every seat in hold');
          err.status = 409;
          throw err;
        }
        await query(
          `UPDATE holds SET status = 'confirmed', booking_id = $1, confirmed_at = $2 WHERE id = $3;`,
          [bookingId, new Date().toISOString(), holdId]
        );
        await query('COMMIT;');
        return {
          id: bookingId,
          holdId,
          sessionId: hold.session_id,
          seatIds,
          status: 'confirmed',
          idempotent: false,
          seats: booked.rows.map(normalizeSeat),
        };
      } catch (err) {
        try { await query('ROLLBACK;'); } catch {}
        throw err;
      }
    });

    if (!booking.idempotent) {
      broadcast('seats-changed', {
        reason: 'booked',
        bookingId: booking.id,
        holdId,
        seats: booking.seats.map((s) => ({ id: s.id, status: 'booked', bookedBy: s.bookedBy })),
      });
    }
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    await expireHolds();
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();

    const released = await enqueueWrite(async () => {
      await query('BEGIN;');
      try {
        const holdResult = await query(`SELECT * FROM holds WHERE id = $1;`, [holdId]);
        if (holdResult.rows.length === 0) {
          await query('ROLLBACK;');
          const err = new Error('Unknown hold');
          err.status = 404;
          throw err;
        }
        const hold = holdResult.rows[0];
        if (sessionId && hold.session_id !== sessionId) {
          await query('ROLLBACK;');
          const err = new Error('Hold belongs to another session');
          err.status = 403;
          throw err;
        }
        if (hold.status !== 'active') {
          await query('COMMIT;');
          return [];
        }
        const released = await query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING id;`,
          [holdId]
        );
        await query(`UPDATE holds SET status = 'released' WHERE id = $1;`, [holdId]);
        await query('COMMIT;');
        return released.rows.map((r) => r.id);
      } catch (err) {
        try { await query('ROLLBACK;'); } catch {}
        throw err;
      }
    });

    if (released.length) {
      broadcast('seats-changed', {
        reason: 'released',
        holdId,
        seats: released.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })),
      });
    }
    res.json({ releasedSeatIds: released });
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const body = { error: err.message || 'Internal server error' };
  if (err.conflictingSeatIds) body.conflictingSeatIds = err.conflictingSeatIds;
  if (status >= 500) console.error(err);
  res.status(status).json(body);
});

await initDb();
setInterval(() => expireHolds().catch((err) => console.error('expiry sweep failed', err)), 1000).unref();

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Seat booking API listening on http://localhost:${PORT}`);
  });
}

export { app, db, initDb, expireHolds };
