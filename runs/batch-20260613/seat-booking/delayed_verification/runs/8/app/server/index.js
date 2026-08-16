import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);

const dataDir = path.join(projectRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new PGlite(path.join(dataDir, 'pglite'));
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const sseClients = new Set();
let writeQueue = Promise.resolve();

function iso(date = new Date()) {
  return date.toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) return null;
  const ids = input.map((x) => String(x || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

function pgArray(values) {
  return `{${values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

async function tx(fn) {
  await query('BEGIN');
  try {
    const value = await fn();
    await query('COMMIT');
    return value;
  } catch (err) {
    try {
      await query('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw err;
  }
}

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function seatForClient(row) {
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

function holdForClient(row, seats = undefined) {
  return {
    id: row.id,
    sessionId: row.session_id,
    seatIds: Array.isArray(row.seat_ids) ? row.seat_ids : [],
    status: row.status,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    releasedAt: row.released_at,
    seats
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

function broadcastSeatChanges(changes, reason) {
  if (!changes || changes.length === 0) return;
  broadcast('seat-changes', { reason, seats: changes.map(seatForClient), at: iso() });
}

function httpError(status, code, message, details = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, details);
  return err;
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL)
      )
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT[] NOT NULL,
      status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ NULL,
      released_at TIMESTAMPTZ NULL
    )
  `);

  await query('CREATE INDEX IF NOT EXISTS idx_seats_status_expiry ON seats(status, hold_expires_at)');
  await query('CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_holds_status_expiry ON holds(status, expires_at)');

  const count = await query('SELECT count(*)::int AS count FROM seats');
  if (Number(count.rows[0]?.count || 0) > 0) return;

  await tx(async () => {
    for (const row of ROWS) {
      for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
        const id = `${row}-${seatNumber}`;
        await query(
          'INSERT INTO seats (id, row_label, seat_number) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [id, row, seatNumber]
        );
      }
    }
  });
}

async function sweepExpiredHolds() {
  return tx(async () => {
    const expiredSeats = await query(`
      SELECT * FROM seats
      WHERE status = 'held' AND hold_expires_at <= now()
      ORDER BY row_label, seat_number
    `);

    await query(`
      UPDATE holds
      SET status = 'expired', released_at = COALESCE(released_at, now())
      WHERE status = 'held' AND expires_at <= now()
    `);

    if (expiredSeats.rows.length === 0) return [];

    await query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
      WHERE status = 'held' AND hold_expires_at <= now()
    `);

    return expiredSeats.rows.map((s) => ({
      ...s,
      status: 'available',
      hold_id: null,
      hold_expires_at: null,
      booked_by: null
    }));
  });
}

async function sweepAndBroadcast() {
  const released = await sweepExpiredHolds();
  broadcastSeatChanges(released, 'expired');
  return released;
}

async function loadSeats() {
  const result = await query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

async function loadInventory() {
  const result = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'available')::int AS available,
      count(*) FILTER (WHERE status = 'held')::int AS held,
      count(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  return result.rows[0];
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ttlSeconds: HOLD_TTL_SECONDS });
});

app.get('/api/seats', async (req, res, next) => {
  try {
    const response = await withWriteLock(async () => {
      await sweepAndBroadcast();
      const seats = await loadSeats();
      const inventory = await loadInventory();
      return { seats: seats.map(seatForClient), inventory, ttlSeconds: HOLD_TTL_SECONDS };
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (req, res, next) => {
  try {
    const inventory = await withWriteLock(async () => {
      await sweepAndBroadcast();
      return loadInventory();
    });
    res.json(inventory);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();

    if (!sessionId) throw httpError(400, 'bad_request', 'sessionId is required');
    if (!seatIds || seatIds.length === 0) throw httpError(400, 'bad_request', 'seatIds must be a non-empty array');

    const response = await withWriteLock(async () => {
      await sweepAndBroadcast();
      const holdId = makeId('hold');
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
      let heldSeats = [];
      let holdRow = null;

      await tx(async () => {
        const requested = await query(
          'SELECT id, status FROM seats WHERE id = ANY($1::text[]) ORDER BY id',
          [pgArray(seatIds)]
        );
        const found = new Set(requested.rows.map((r) => r.id));
        const missing = seatIds.filter((id) => !found.has(id));
        const conflicting = requested.rows.filter((r) => r.status !== 'available').map((r) => r.id);

        if (missing.length > 0) {
          throw httpError(400, 'unknown_seats', 'One or more requested seats do not exist', { missingSeatIds: missing });
        }
        if (conflicting.length > 0) {
          throw httpError(409, 'seats_unavailable', 'One or more requested seats are unavailable', { conflictingSeatIds: conflicting });
        }

        await query(
          `INSERT INTO holds (id, session_id, seat_ids, status, expires_at)
           VALUES ($1, $2, $3::text[], 'held', $4::timestamptz)`,
          [holdId, sessionId, pgArray(seatIds), expiresAt]
        );

        const updated = await query(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2::timestamptz, booked_by = NULL
           WHERE id = ANY($3::text[]) AND status = 'available'
           RETURNING *`,
          [holdId, expiresAt, pgArray(seatIds)]
        );

        if (updated.rows.length !== seatIds.length) {
          const after = await query(
            "SELECT id FROM seats WHERE id = ANY($1::text[]) AND status <> 'available' ORDER BY id",
            [pgArray(seatIds)]
          );
          throw httpError(409, 'seats_unavailable', 'One or more requested seats are unavailable', {
            conflictingSeatIds: after.rows.map((r) => r.id)
          });
        }

        const hold = await query('SELECT * FROM holds WHERE id = $1', [holdId]);
        heldSeats = updated.rows;
        holdRow = hold.rows[0];
      });

      broadcastSeatChanges(heldSeats, 'held');
      return { hold: holdForClient(holdRow, heldSeats.map(seatForClient)) };
    });

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId) throw httpError(400, 'bad_request', 'holdId is required');

    const response = await withWriteLock(async () => {
      await sweepAndBroadcast();
      let bookedSeats = [];
      let holdRow = null;
      let idempotent = false;

      await tx(async () => {
        const holdResult = await query('SELECT * FROM holds WHERE id = $1', [holdId]);
        holdRow = holdResult.rows[0];

        if (!holdRow) throw httpError(404, 'unknown_hold', 'Unknown hold');
        if (sessionId && holdRow.session_id !== sessionId) throw httpError(403, 'wrong_session', 'Hold belongs to a different session');

        if (holdRow.status === 'confirmed') {
          const seats = await query(
            "SELECT * FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY row_label, seat_number",
            [holdId]
          );
          bookedSeats = seats.rows;
          idempotent = true;
          return;
        }

        if (holdRow.status === 'expired') throw httpError(409, 'hold_expired', 'Hold has expired');
        if (holdRow.status !== 'held') throw httpError(409, 'hold_not_active', `Hold is ${holdRow.status}`);

        const owned = await query(
          "SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now() ORDER BY row_label, seat_number",
          [holdId]
        );
        const expectedSeatIds = Array.isArray(holdRow.seat_ids) ? holdRow.seat_ids : [];
        if (owned.rows.length !== expectedSeatIds.length) {
          throw httpError(409, 'hold_invalid', 'Hold no longer owns all of its active seats');
        }

        const updated = await query(
          `UPDATE seats
           SET status = 'booked', booked_by = $2, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now()
           RETURNING *`,
          [holdId, holdRow.session_id]
        );
        if (updated.rows.length !== expectedSeatIds.length) {
          throw httpError(409, 'hold_invalid', 'Hold could not be confirmed atomically');
        }

        bookedSeats = updated.rows;
        const updatedHold = await query(
          `UPDATE holds
           SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now())
           WHERE id = $1 AND status = 'held'
           RETURNING *`,
          [holdId]
        );
        holdRow = updatedHold.rows[0];
      });

      if (!idempotent) broadcastSeatChanges(bookedSeats, 'booked');
      return { booking: holdForClient(holdRow, bookedSeats.map(seatForClient)), idempotent };
    });

    res.json(response);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!holdId) throw httpError(400, 'bad_request', 'holdId is required');

    const response = await withWriteLock(async () => {
      await sweepAndBroadcast();
      let releasedSeats = [];
      let holdRow = null;

      await tx(async () => {
        const holdResult = await query('SELECT * FROM holds WHERE id = $1', [holdId]);
        holdRow = holdResult.rows[0];
        if (!holdRow) throw httpError(404, 'unknown_hold', 'Unknown hold');
        if (sessionId && holdRow.session_id !== sessionId) throw httpError(403, 'wrong_session', 'Hold belongs to a different session');
        if (holdRow.status === 'confirmed') throw httpError(409, 'already_booked', 'Confirmed bookings cannot be released');
        if (holdRow.status !== 'held') return;

        const seats = await query(
          "SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY row_label, seat_number",
          [holdId]
        );
        await query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        const updatedHold = await query(
          `UPDATE holds
           SET status = 'released', released_at = COALESCE(released_at, now())
           WHERE id = $1
           RETURNING *`,
          [holdId]
        );
        releasedSeats = seats.rows.map((s) => ({
          ...s,
          status: 'available',
          hold_id: null,
          hold_expires_at: null,
          booked_by: null
        }));
        holdRow = updatedHold.rows[0];
      });

      broadcastSeatChanges(releasedSeats, 'released');
      return { hold: holdForClient(holdRow, releasedSeats.map(seatForClient)), released: releasedSeats.length };
    });

    res.json(response);
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', at: iso(), ttlSeconds: HOLD_TTL_SECONDS })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.use(express.static(path.join(projectRoot, 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { code: 'not_found', message: 'API route not found' } });
  }
  res.sendFile(path.join(projectRoot, 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      message: err.message || 'Internal server error',
      conflictingSeatIds: err.conflictingSeatIds,
      missingSeatIds: err.missingSeatIds
    }
  });
});

await initDb();

setInterval(() => {
  withWriteLock(sweepAndBroadcast).catch((err) => console.error('expiry sweep failed', err));
}, Math.max(1000, Math.min(10_000, HOLD_TTL_SECONDS * 500)));

app.listen(PORT, () => {
  console.log(`Seat booking backend listening on http://localhost:${PORT}`);
  console.log(`Seat map: ${ROWS.length * SEATS_PER_ROW} seats, hold TTL ${HOLD_TTL_SECONDS}s`);
});
