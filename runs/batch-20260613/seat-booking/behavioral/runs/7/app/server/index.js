import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 1_000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new PGlite(process.env.DATABASE_URL || path.join(__dirname, '..', 'data', 'pglite'));

const app = express();
app.use(cors());
app.use(express.json());

const sseClients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

async function transaction(fn) {
  await db.exec('BEGIN');
  try {
    const result = await fn(db);
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.exec('ROLLBACK');
    } catch (_) {
      // Ignore rollback failures; preserve the original error.
    }
    throw error;
  }
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function normalizeSeatIds(seatIds) {
  if (!Array.isArray(seatIds)) return [];
  return [...new Set(seatIds.map((id) => String(id).trim()).filter(Boolean))];
}

function placeholders(values, offset = 1) {
  return values.map((_, index) => `$${index + offset}`).join(', ');
}

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function publicSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.status === 'held' ? row.hold_id : null,
    holdExpiresAt: row.status === 'held' ? toIso(row.hold_expires_at) : null,
    bookedBy: row.status === 'booked' ? row.booked_by : null
  };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')) DEFAULT 'available',
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      CHECK ((status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'booked', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ NULL,
      released_at TIMESTAMPTZ NULL,
      seat_count INTEGER NOT NULL,
      booking_id TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_status_expiry ON holds(status, expires_at);
  `);

  const seeded = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(seeded.rows[0].count) === 0) {
    await transaction(async (tx) => {
      for (const row of ROWS) {
        for (let number = 1; number <= SEATS_PER_ROW; number += 1) {
          const id = `${row}-${number}`;
          await tx.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [id, row, number, 'available']
          );
        }
      }
    });
  }
}

async function inventory(tx = db) {
  const result = await tx.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'held')::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  const row = result.rows[0];
  return {
    total: Number(row.total),
    available: Number(row.available),
    held: Number(row.held),
    booked: Number(row.booked)
  };
}

async function selectSeatsByIds(tx, ids) {
  if (ids.length === 0) return [];
  const result = await tx.query(
    `SELECT * FROM seats WHERE id IN (${placeholders(ids)}) ORDER BY row_label, seat_number`,
    ids
  );
  return result.rows;
}

async function sweepExpiredInternal(tx, at = nowIso()) {
  const expiredSeats = await tx.query(
    `SELECT id, row_label, seat_number, hold_id
       FROM seats
      WHERE status = 'held' AND hold_expires_at <= $1
      ORDER BY row_label, seat_number`,
    [at]
  );

  if (expiredSeats.rows.length === 0) return [];

  const expiredHoldIds = [...new Set(expiredSeats.rows.map((row) => row.hold_id).filter(Boolean))];
  await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
      WHERE status = 'held' AND hold_expires_at <= $1`,
    [at]
  );

  if (expiredHoldIds.length > 0) {
    await tx.query(
      `UPDATE holds
          SET status = 'expired', released_at = $${expiredHoldIds.length + 1}
        WHERE status = 'active' AND id IN (${placeholders(expiredHoldIds)})`,
      [...expiredHoldIds, at]
    );
  }

  return expiredSeats.rows.map((row) => ({
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: 'available',
    holdId: null,
    holdExpiresAt: null,
    bookedBy: null
  }));
}

async function sweepExpiredAndBroadcast() {
  const releasedSeats = await enqueueWrite(() => transaction((tx) => sweepExpiredInternal(tx)));
  if (releasedSeats.length > 0) {
    broadcast('seats', { type: 'released', seats: releasedSeats, inventory: await inventory() });
  }
  return releasedSeats;
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(data);
}

async function allSeats() {
  await sweepExpiredAndBroadcast();
  const result = await db.query('SELECT * FROM seats ORDER BY row_label, seat_number');
  return result.rows.map(publicSeat);
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, inventory: await inventory() });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await allSeats();
    res.json({ seats, inventory: await inventory(), holdTtlMs: HOLD_TTL_MS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) throw httpError(400, 'sessionId is required');
    if (seatIds.length === 0) throw httpError(400, 'seatIds must contain at least one seat id');

    const result = await enqueueWrite(() => transaction(async (tx) => {
      const expiryReleases = await sweepExpiredInternal(tx);
      const existingSeats = await selectSeatsByIds(tx, seatIds);
      const existingIds = new Set(existingSeats.map((seat) => seat.id));
      const missingIds = seatIds.filter((id) => !existingIds.has(id));
      const occupied = existingSeats.filter((seat) => seat.status !== 'available').map((seat) => seat.id);
      const conflictingSeatIds = [...missingIds, ...occupied];

      if (conflictingSeatIds.length > 0 || existingSeats.length !== seatIds.length) {
        throw httpError(409, 'One or more seats are unavailable', { conflictingSeatIds, expiredSeats: expiryReleases });
      }

      const holdId = crypto.randomUUID();
      const at = nowIso();
      const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
      await tx.query(
        `INSERT INTO holds (id, session_id, status, created_at, expires_at, seat_count)
         VALUES ($1, $2, 'active', $3, $4, $5)`,
        [holdId, sessionId, at, expiresAt, seatIds.length]
      );
      await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}, booked_by = NULL
          WHERE id IN (${placeholders(seatIds)}) AND status = 'available'`,
        [...seatIds, holdId, expiresAt]
      );
      const heldSeats = (await selectSeatsByIds(tx, seatIds)).map(publicSeat);
      return { expiryReleases, hold: { id: holdId, sessionId, seatIds, expiresAt }, heldSeats };
    }));

    if (result.expiryReleases.length > 0) {
      broadcast('seats', { type: 'released', seats: result.expiryReleases, inventory: await inventory() });
    }
    broadcast('seats', { type: 'held', hold: result.hold, seats: result.heldSeats, inventory: await inventory() });
    res.status(201).json({ hold: result.hold, seats: result.heldSeats, inventory: await inventory() });
  } catch (error) {
    if (error.expiredSeats?.length) {
      broadcast('seats', { type: 'released', seats: error.expiredSeats, inventory: await inventory() });
    }
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId).trim() : null;
    if (!holdId) throw httpError(400, 'hold id is required');

    const result = await enqueueWrite(() => transaction(async (tx) => {
      const expiryReleases = await sweepExpiredInternal(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) throw httpError(404, 'Unknown hold', { expiredSeats: expiryReleases });
      const hold = holdResult.rows[0];
      if (sessionId && sessionId !== hold.session_id) {
        throw httpError(403, 'Hold belongs to a different session', { expiredSeats: expiryReleases });
      }

      if (hold.status === 'booked') {
        const bookedSeats = (await tx.query(
          'SELECT * FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY row_label, seat_number',
          [holdId, 'booked']
        )).rows.map(publicSeat);
        return {
          idempotent: true,
          expiryReleases,
          booking: {
            id: hold.booking_id || holdId,
            holdId,
            sessionId: hold.session_id,
            seatIds: bookedSeats.map((seat) => seat.id),
            confirmedAt: toIso(hold.confirmed_at)
          },
          bookedSeats
        };
      }

      if (hold.status !== 'active') {
        throw httpError(409, `Hold is ${hold.status}`, { expiredSeats: expiryReleases });
      }

      if (new Date(hold.expires_at).getTime() <= Date.now()) {
        await sweepExpiredInternal(tx);
        throw httpError(409, 'Hold has expired', { expiredSeats: expiryReleases });
      }

      const heldSeats = (await tx.query(
        'SELECT * FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY row_label, seat_number',
        [holdId, 'held']
      )).rows;
      if (heldSeats.length !== Number(hold.seat_count)) {
        throw httpError(409, 'Hold no longer owns all of its seats', { expiredSeats: expiryReleases });
      }

      const bookingId = hold.booking_id || crypto.randomUUID();
      const confirmedAt = nowIso();
      await tx.query(
        `UPDATE seats
            SET status = 'booked', hold_expires_at = NULL, booked_by = $2
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId, hold.session_id]
      );
      await tx.query(
        `UPDATE holds
            SET status = 'booked', confirmed_at = $2, booking_id = $3
          WHERE id = $1`,
        [holdId, confirmedAt, bookingId]
      );
      const bookedSeats = (await tx.query(
        'SELECT * FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY row_label, seat_number',
        [holdId, 'booked']
      )).rows.map(publicSeat);
      return {
        idempotent: false,
        expiryReleases,
        booking: { id: bookingId, holdId, sessionId: hold.session_id, seatIds: bookedSeats.map((seat) => seat.id), confirmedAt },
        bookedSeats
      };
    }));

    if (result.expiryReleases.length > 0) {
      broadcast('seats', { type: 'released', seats: result.expiryReleases, inventory: await inventory() });
    }
    if (!result.idempotent) {
      broadcast('seats', { type: 'booked', booking: result.booking, seats: result.bookedSeats, inventory: await inventory() });
    }
    res.json({ booking: result.booking, seats: result.bookedSeats, idempotent: result.idempotent, inventory: await inventory() });
  } catch (error) {
    if (error.expiredSeats?.length) {
      broadcast('seats', { type: 'released', seats: error.expiredSeats, inventory: await inventory() });
    }
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId).trim() : null;

    const result = await enqueueWrite(() => transaction(async (tx) => {
      const expiryReleases = await sweepExpiredInternal(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) return { expiryReleases, releasedSeats: [], status: 'unknown' };
      const hold = holdResult.rows[0];
      if (sessionId && sessionId !== hold.session_id) throw httpError(403, 'Hold belongs to a different session', { expiredSeats: expiryReleases });
      if (hold.status === 'booked') throw httpError(409, 'Booked holds cannot be released', { expiredSeats: expiryReleases });
      if (hold.status !== 'active') return { expiryReleases, releasedSeats: [], status: hold.status };

      const heldSeats = (await tx.query(
        `SELECT id, row_label, seat_number FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY row_label, seat_number`,
        [holdId]
      )).rows;
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await tx.query(
        `UPDATE holds SET status = 'released', released_at = $2 WHERE id = $1`,
        [holdId, nowIso()]
      );
      const releasedSeats = heldSeats.map((row) => ({
        id: row.id,
        rowLabel: row.row_label,
        seatNumber: Number(row.seat_number),
        status: 'available',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: null
      }));
      return { expiryReleases, releasedSeats, status: 'released' };
    }));

    if (result.expiryReleases.length > 0) {
      broadcast('seats', { type: 'released', seats: result.expiryReleases, inventory: await inventory() });
    }
    if (result.releasedSeats.length > 0) {
      broadcast('seats', { type: 'released', seats: result.releasedSeats, inventory: await inventory() });
    }
    res.json({ status: result.status, seats: result.releasedSeats, inventory: await inventory() });
  } catch (error) {
    if (error.expiredSeats?.length) {
      broadcast('seats', { type: 'released', seats: error.expiredSeats, inventory: await inventory() });
    }
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  try {
    res.write(`event: snapshot\ndata: ${JSON.stringify({ type: 'snapshot', seats: await allSeats(), inventory: await inventory() })}\n\n`);
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const payload = { error: err.message || 'Internal server error' };
  if (err.conflictingSeatIds) payload.conflictingSeatIds = err.conflictingSeatIds;
  res.status(status).json(payload);
});

await initDb();
setInterval(() => {
  sweepExpiredAndBroadcast().catch((error) => console.error('expiry sweep failed', error));
}, SWEEP_INTERVAL_MS).unref();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
});
