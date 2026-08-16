import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const app = express();
app.use(cors());
app.use(express.json());

const dataDir = process.env.PGLITE_DATA_DIR || './server/data/pglite';
mkdirSync(dataDir, { recursive: true });
const db = new PGlite(dataDir);

const clients = new Set();
let lockQueue = Promise.resolve();

function withDbLock(fn) {
  const run = lockQueue.then(fn, fn);
  lockQueue = run.catch(() => {});
  return run;
}

async function withTransaction(fn) {
  await db.query('BEGIN;');
  try {
    const result = await fn();
    await db.query('COMMIT;');
    return result;
  } catch (err) {
    await db.query('ROLLBACK;');
    throw err;
  }
}

function inList(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(', ');
}

function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  };
}

function normalizeHold(row, seatIds = []) {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    bookingId: row.booking_id,
    seatIds
  };
}

function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

function broadcastSeatChanges(action, seats) {
  if (!seats.length) return;
  broadcast('seats', { action, seats: seats.map(normalizeSeat) });
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')) DEFAULT 'available',
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
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ NULL,
      booking_id TEXT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
      seat_id INTEGER NOT NULL REFERENCES seats(id),
      PRIMARY KEY (hold_id, seat_id)
    );
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (Number(count.rows[0].count) === 0) {
    let id = 1;
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4);',
          [id, row, n, 'available']
        );
        id += 1;
      }
    }
  }
}

async function getHoldSeatIds(holdId) {
  const result = await db.query('SELECT seat_id FROM hold_seats WHERE hold_id = $1 ORDER BY seat_id;', [holdId]);
  return result.rows.map((r) => r.seat_id);
}

async function releaseExpiredHolds() {
  const expired = await db.query(`
    SELECT id FROM holds
    WHERE status = 'active' AND expires_at <= NOW()
    ORDER BY expires_at;
  `);
  const holdIds = expired.rows.map((r) => r.id);
  if (!holdIds.length) return [];

  const releasedSeats = await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held'
      AND hold_id IN (${inList(holdIds)})
    RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
  `, holdIds);

  await db.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE id IN (${inList(holdIds)}) AND status = 'active';
  `, holdIds);

  return releasedSeats.rows;
}

async function sweepAndBroadcast() {
  const released = await withDbLock(() => releaseExpiredHolds());
  broadcastSeatChanges('released', released);
  return released;
}

async function loadSeats() {
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number;
  `);
  return result.rows.map(normalizeSeat);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    let released = [];
    const seats = await withDbLock(async () => {
      released = await releaseExpiredHolds();
      return loadSeats();
    });
    broadcastSeatChanges('released', released);
    res.json({ seats, totals: summarizeSeats(seats), holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected' })}\n\n`);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const ids = [...new Set((Array.isArray(seatIds) ? seatIds : []).map(Number))].filter(Number.isInteger);

    if (!sessionId || !ids.length) {
      return res.status(400).json({ error: 'sessionId and a non-empty seatIds array are required' });
    }

    let heldSeats = [];
    let released = [];
    const result = await withDbLock(() => withTransaction(async () => {
      released = await releaseExpiredHolds();

      const seatsResult = await db.query(`
        SELECT id, status FROM seats
        WHERE id IN (${inList(ids)})
        ORDER BY id;
      `, ids);
      const foundIds = new Set(seatsResult.rows.map((r) => r.id));
      const conflicts = [
        ...ids.filter((id) => !foundIds.has(id)),
        ...seatsResult.rows.filter((r) => r.status !== 'available').map((r) => r.id)
      ].sort((a, b) => a - b);

      if (conflicts.length) {
        return { ok: false, conflicts };
      }

      const holdId = randomUUID();
      const holdInsert = await db.query(`
        INSERT INTO holds (id, session_id, status, expires_at)
        VALUES ($1, $2, 'active', NOW() + ($3::text || ' seconds')::interval)
        RETURNING id, session_id, status, created_at, expires_at, confirmed_at, booking_id;
      `, [holdId, sessionId, HOLD_TTL_SECONDS]);

      for (const seatId of ids) {
        await db.query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2);', [holdId, seatId]);
      }

      const updateResult = await db.query(`
        UPDATE seats
        SET status = 'held', hold_id = $1, hold_expires_at = (SELECT expires_at FROM holds WHERE id = $1)
        WHERE id IN (${inList(ids, 2)}) AND status = 'available'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
      `, [holdId, ...ids]);

      if (updateResult.rows.length !== ids.length) {
        throw new Error('Atomic hold failed: not all requested seats were acquired');
      }
      heldSeats = updateResult.rows;
      return { ok: true, hold: normalizeHold(holdInsert.rows[0], ids) };
    }));

    broadcastSeatChanges('released', released);
    if (!result.ok) {
      return res.status(409).json({ error: 'One or more requested seats are unavailable', conflictingSeatIds: result.conflicts });
    }
    broadcastSeatChanges('held', heldSeats);
    res.status(201).json({ hold: result.hold, seats: heldSeats.map(normalizeSeat) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    let bookedSeats = [];
    let released = [];

    const result = await withDbLock(() => withTransaction(async () => {
      released = await releaseExpiredHolds();

      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
      if (!holdResult.rows.length) return { ok: false, status: 404, error: 'Unknown hold' };
      const hold = holdResult.rows[0];
      const seatIds = await getHoldSeatIds(holdId);

      if (sessionId && sessionId !== hold.session_id) {
        return { ok: false, status: 403, error: 'Hold belongs to a different session' };
      }

      if (hold.status === 'confirmed') {
        const seats = seatIds.length
          ? await db.query(`
              SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
              FROM seats WHERE id IN (${inList(seatIds)}) ORDER BY id;
            `, seatIds)
          : { rows: [] };
        bookedSeats = seats.rows;
        return { ok: true, idempotent: true, hold: normalizeHold(hold, seatIds) };
      }

      if (hold.status !== 'active') {
        return { ok: false, status: 409, error: `Cannot confirm a ${hold.status} hold` };
      }

      const activeCheck = await db.query('SELECT (expires_at > NOW()) AS active FROM holds WHERE id = $1;', [holdId]);
      if (!activeCheck.rows[0]?.active) {
        await releaseExpiredHolds();
        return { ok: false, status: 409, error: 'Hold has expired' };
      }

      const heldSeats = await db.query(`
        SELECT id FROM seats
        WHERE hold_id = $1 AND status = 'held'
        ORDER BY id;
      `, [holdId]);
      if (heldSeats.rows.length !== seatIds.length) {
        return { ok: false, status: 409, error: 'Hold no longer owns all of its seats' };
      }

      const bookingId = randomUUID();
      const updateSeats = await db.query(`
        UPDATE seats
        SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $2
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
      `, [holdId, hold.session_id]);
      bookedSeats = updateSeats.rows;

      const updatedHold = await db.query(`
        UPDATE holds
        SET status = 'confirmed', confirmed_at = NOW(), booking_id = $2
        WHERE id = $1 AND status = 'active'
        RETURNING id, session_id, status, created_at, expires_at, confirmed_at, booking_id;
      `, [holdId, bookingId]);

      return { ok: true, idempotent: false, hold: normalizeHold(updatedHold.rows[0], seatIds) };
    }));

    broadcastSeatChanges('released', released);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (!result.idempotent) broadcastSeatChanges('booked', bookedSeats);
    res.json({ hold: result.hold, seats: bookedSeats.map(normalizeSeat), bookingId: result.hold.bookingId });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    let releasedSeats = [];
    let expiredReleased = [];

    const result = await withDbLock(() => withTransaction(async () => {
      expiredReleased = await releaseExpiredHolds();
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
      if (!holdResult.rows.length) return { ok: false, status: 404, error: 'Unknown hold' };
      const hold = holdResult.rows[0];
      if (sessionId && sessionId !== hold.session_id) {
        return { ok: false, status: 403, error: 'Hold belongs to a different session' };
      }
      if (hold.status !== 'active') {
        return { ok: true, alreadyDone: true, hold: normalizeHold(hold, await getHoldSeatIds(holdId)) };
      }

      const updateSeats = await db.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
      `, [holdId]);
      releasedSeats = updateSeats.rows;
      const updatedHold = await db.query(`
        UPDATE holds SET status = 'released' WHERE id = $1
        RETURNING id, session_id, status, created_at, expires_at, confirmed_at, booking_id;
      `, [holdId]);
      return { ok: true, hold: normalizeHold(updatedHold.rows[0], await getHoldSeatIds(holdId)) };
    }));

    broadcastSeatChanges('released', expiredReleased);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    broadcastSeatChanges('released', releasedSeats);
    res.json({ hold: result.hold, seats: releasedSeats.map(normalizeSeat) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    let released = [];
    const seats = await withDbLock(async () => {
      released = await releaseExpiredHolds();
      return loadSeats();
    });
    broadcastSeatChanges('released', released);
    res.json(summarizeSeats(seats));
  } catch (err) {
    next(err);
  }
});

function summarizeSeats(seats) {
  return seats.reduce((acc, seat) => {
    acc.total += 1;
    acc[seat.status] += 1;
    return acc;
  }, { total: 0, available: 0, held: 0, booked: 0 });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'development' ? String(err?.message || err) : undefined });
});

await initDb();

setInterval(() => {
  sweepAndBroadcast().catch((err) => console.error('expiry sweep failed', err));
}, 1000).unref();

setInterval(() => {
  broadcast('heartbeat', { now: new Date().toISOString() });
}, 15000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
