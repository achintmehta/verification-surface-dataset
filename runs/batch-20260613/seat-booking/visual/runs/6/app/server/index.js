import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 30);

await mkdir(path.join(ROOT, 'data'), { recursive: true });
const db = new PGlite(path.join(ROOT, 'data', 'pglite'));

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }
  async run(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
const mutex = new Mutex();

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();

function rows(result) {
  return result?.rows || [];
}

function buildIn(values, start = 1) {
  return values.map((_, index) => `$${start + index}`).join(', ');
}

async function transaction(fn) {
  return mutex.run(async () => {
    await db.query('BEGIN');
    try {
      const result = await fn();
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch {}
      throw error;
    }
  });
}

function sendSse(res, event) {
  res.write(`event: ${event.type || 'message'}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  const payload = { at: new Date().toISOString(), ...event };
  for (const res of clients) {
    try {
      sendSse(res, payload);
    } catch {
      clients.delete(res);
    }
  }
}

function broadcastSeatChanges(seats, status, extra = {}) {
  if (!seats.length) return;
  broadcast({
    type: 'seat-update',
    action: status === 'available' ? 'released' : status,
    seats: seats.map((seat) => ({
      id: Number(seat.id),
      row_label: seat.row_label,
      seat_number: Number(seat.seat_number),
      status,
      hold_id: status === 'held' ? seat.hold_id : null,
      hold_expires_at: status === 'held' ? seat.hold_expires_at : null,
      booked_by: status === 'booked' ? seat.booked_by : null,
    })),
    ...extra,
  });
}

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) throw httpError(400, 'seatIds must be an array');
  const ids = [...new Set(input.map((id) => Number(id)).filter(Number.isInteger))];
  if (!ids.length) throw httpError(400, 'At least one valid seat id is required');
  if (ids.length > 20) throw httpError(400, 'A hold may contain at most 20 seats');
  return ids;
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available','held','booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE (row_label, seat_number)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('held','booked','released','expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ NULL,
      booking_id TEXT NULL
    );
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_status_expires ON seats(status, hold_expires_at);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);');

  const count = Number(rows(await db.query('SELECT COUNT(*)::int AS count FROM seats'))[0].count);
  if (count === 0) {
    const values = [];
    const params = [];
    let seatId = 1;
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
        params.push(seatId, row, n, 'available');
        const base = params.length - 3;
        values.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3})`);
        seatId += 1;
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')}`,
      params,
    );
  }
}

async function sweepExpiredHolds() {
  const expired = await transaction(async () => {
    const expiredSeats = rows(await db.query(`
      UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at <= NOW()
       RETURNING id, row_label, seat_number
    `));
    await db.query(`
      UPDATE holds
         SET status = 'expired'
       WHERE status = 'held' AND expires_at <= NOW()
    `);
    return expiredSeats;
  });
  broadcastSeatChanges(expired, 'available', { reason: 'expired' });
  return expired;
}

async function getSeats() {
  const result = await transaction(async () => {
    const released = rows(await db.query(`
      UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at <= NOW()
       RETURNING id, row_label, seat_number
    `));
    await db.query(`UPDATE holds SET status = 'expired' WHERE status = 'held' AND expires_at <= NOW()`);

    const seatRows = rows(await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM seats
       ORDER BY row_label, seat_number
    `));
    const inventory = rows(await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available,
        COUNT(*) FILTER (WHERE status = 'held')::int AS held,
        COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
      FROM seats
    `))[0];
    return { seats: seatRows, inventory, released };
  });
  broadcastSeatChanges(result.released, 'available', { reason: 'expired' });
  return { ...result, ttlSeconds: HOLD_TTL_SECONDS, released: result.released.map((s) => Number(s.id)) };
}

app.get('/api/health', async (_req, res, next) => {
  try {
    const inventory = rows(await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'available')::int AS available,
             COUNT(*) FILTER (WHERE status = 'held')::int AS held,
             COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
        FROM seats
    `))[0];
    res.json({ ok: true, inventory });
  } catch (error) {
    next(error);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    res.json(await getSeats());
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body.seatIds);
    const sessionId = String(req.body.sessionId || '').trim();
    if (!sessionId) throw httpError(400, 'sessionId is required');

    const result = await transaction(async () => {
      const expiredSeats = rows(await db.query(`
        UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE status = 'held' AND hold_expires_at <= NOW()
         RETURNING id, row_label, seat_number
      `));
      await db.query(`UPDATE holds SET status = 'expired' WHERE status = 'held' AND expires_at <= NOW()`);

      const placeholders = buildIn(seatIds);
      const selected = rows(await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, booked_by
           FROM seats
          WHERE id IN (${placeholders})
          ORDER BY id`,
        seatIds,
      ));
      const foundIds = new Set(selected.map((seat) => Number(seat.id)));
      const conflicts = [
        ...seatIds.filter((id) => !foundIds.has(id)).map((id) => ({ id, status: 'missing' })),
        ...selected.filter((seat) => seat.status !== 'available').map((seat) => ({ id: Number(seat.id), status: seat.status })),
      ];
      if (conflicts.length) {
        return { ok: false, status: 409, conflicts, expiredSeats };
      }

      const holdId = randomUUID();
      const expiresAt = rows(await db.query(
        `INSERT INTO holds (id, session_id, expires_at, status)
         VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 second'), 'held')
         RETURNING expires_at`,
        [holdId, sessionId, HOLD_TTL_SECONDS],
      ))[0].expires_at;

      const updateParams = [holdId, expiresAt, ...seatIds];
      const updated = rows(await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${buildIn(seatIds, 3)}) AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at`,
        updateParams,
      ));
      if (updated.length !== seatIds.length) {
        throw httpError(409, 'Seats were acquired by another request', { conflicts: seatIds });
      }
      return { ok: true, holdId, expiresAt, updated, expiredSeats };
    });

    broadcastSeatChanges(result.expiredSeats || [], 'available', { reason: 'expired' });
    if (!result.ok) {
      return res.status(result.status).json({ error: 'Some seats are unavailable', conflicts: result.conflicts });
    }
    broadcastSeatChanges(result.updated, 'held', { holdId: result.holdId, sessionId });
    res.status(201).json({
      hold: {
        id: result.holdId,
        sessionId,
        seatIds,
        expiresAt: result.expiresAt,
        ttlSeconds: HOLD_TTL_SECONDS,
        status: 'held',
      },
      seats: result.updated,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body.sessionId || '').trim();
    if (!sessionId) throw httpError(400, 'sessionId is required');

    const result = await transaction(async () => {
      const expiredSeats = rows(await db.query(`
        UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE status = 'held' AND hold_expires_at <= NOW()
         RETURNING id, row_label, seat_number
      `));
      await db.query(`UPDATE holds SET status = 'expired' WHERE status = 'held' AND expires_at <= NOW()`);

      const hold = rows(await db.query('SELECT * FROM holds WHERE id = $1', [holdId]))[0];
      if (!hold) return { ok: false, status: 404, message: 'Unknown hold', expiredSeats };
      if (hold.session_id !== sessionId) return { ok: false, status: 403, message: 'Hold belongs to a different session', expiredSeats };

      if (hold.status === 'booked') {
        const bookedSeats = rows(await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY id`,
          [holdId],
        ));
        return { ok: true, alreadyBooked: true, bookingId: hold.booking_id, seats: bookedSeats, expiredSeats };
      }

      if (hold.status !== 'held') return { ok: false, status: 409, message: `Hold is ${hold.status}`, expiredSeats };

      const heldSeats = rows(await db.query(
        `SELECT id, row_label, seat_number
           FROM seats
          WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW()
          ORDER BY id`,
        [holdId],
      ));
      if (!heldSeats.length) {
        await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'held'`, [holdId]);
        return { ok: false, status: 409, message: 'Hold is expired or owns no active seats', expiredSeats };
      }

      const bookingId = hold.booking_id || randomUUID();
      const bookedSeats = rows(await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW()
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId, sessionId],
      ));
      if (bookedSeats.length !== heldSeats.length) throw httpError(409, 'Hold changed while confirming');
      await db.query(
        `UPDATE holds SET status = 'booked', confirmed_at = NOW(), booking_id = $2 WHERE id = $1`,
        [holdId, bookingId],
      );
      return { ok: true, alreadyBooked: false, bookingId, seats: bookedSeats, expiredSeats };
    });

    broadcastSeatChanges(result.expiredSeats || [], 'available', { reason: 'expired' });
    if (!result.ok) return res.status(result.status).json({ error: result.message });
    if (!result.alreadyBooked) broadcastSeatChanges(result.seats, 'booked', { holdId, bookingId: result.bookingId, sessionId });
    res.json({
      booking: { id: result.bookingId, holdId, sessionId, alreadyBooked: result.alreadyBooked, seatIds: result.seats.map((s) => Number(s.id)) },
      seats: result.seats,
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body.sessionId || req.query.sessionId || '').trim();
    if (!sessionId) throw httpError(400, 'sessionId is required');

    const result = await transaction(async () => {
      const expiredSeats = rows(await db.query(`
        UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE status = 'held' AND hold_expires_at <= NOW()
         RETURNING id, row_label, seat_number
      `));
      await db.query(`UPDATE holds SET status = 'expired' WHERE status = 'held' AND expires_at <= NOW()`);

      const hold = rows(await db.query('SELECT * FROM holds WHERE id = $1', [holdId]))[0];
      if (!hold) return { ok: false, status: 404, message: 'Unknown hold', expiredSeats };
      if (hold.session_id !== sessionId) return { ok: false, status: 403, message: 'Hold belongs to a different session', expiredSeats };
      if (hold.status !== 'held') return { ok: true, released: [], expiredSeats, statusText: hold.status };

      const released = rows(await db.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number`,
        [holdId],
      ));
      await db.query(`UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'held'`, [holdId]);
      return { ok: true, released, expiredSeats, statusText: 'released' };
    });

    broadcastSeatChanges(result.expiredSeats || [], 'available', { reason: 'expired' });
    if (!result.ok) return res.status(result.status).json({ error: result.message });
    broadcastSeatChanges(result.released || [], 'available', { reason: 'released', holdId, sessionId });
    res.json({ hold: { id: holdId, status: result.statusText }, releasedSeatIds: (result.released || []).map((s) => Number(s.id)) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  clients.add(res);
  sendSse(res, { type: 'connected', at: new Date().toISOString(), ttlSeconds: HOLD_TTL_SECONDS });
  const heartbeat = setInterval(() => sendSse(res, { type: 'heartbeat', at: new Date().toISOString() }), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// Serve the production frontend if `npm run build` has been run.
app.use(express.static(path.join(ROOT, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'dist', 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend not built. Run npm run client for development or npm run build.');
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error', conflicts: err.conflicts });
});

await initDb();
setInterval(() => {
  sweepExpiredHolds().catch((error) => console.error('expiry sweep failed', error));
}, 1000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`Seat map: ${ROWS.length} rows x ${SEATS_PER_ROW} seats, hold TTL ${HOLD_TTL_SECONDS}s`);
});
