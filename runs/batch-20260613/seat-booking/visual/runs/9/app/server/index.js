import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 30);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new PGlite(DATA_DIR);

// PGLite runs in-process. This small mutex serializes write transactions so every
// read/modify/write sequence below is atomic from the application's perspective.
let writeQueue = Promise.resolve();
async function withWriteLock(fn) {
  const previous = writeQueue;
  let release;
  writeQueue = new Promise((resolve) => (release = resolve));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function tx(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

function isoFromDb(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function publicSeat(row) {
  const holdExpiresAt = isoFromDb(row.hold_expires_at);
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt,
    bookedBy: row.booked_by,
    // Snake_case aliases make the API convenient for SQL-oriented tests/clients too.
    row_label: row.row_label,
    seat_number: row.seat_number,
    hold_id: row.hold_id,
    hold_expires_at: holdExpiresAt,
    booked_by: row.booked_by,
  };
}

const clients = new Set();
function broadcast(event, payload) {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(body);
    } catch {
      clients.delete(res);
    }
  }
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number),
      CHECK ((status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL))
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ,
      booking_id TEXT
    );
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(existing.rows[0].count) === 0) {
    await tx(async (q) => {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n++) {
          await q.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [`${row}${n}`, row, n, 'available'],
          );
        }
      }
    });
  }
}

async function sweepExpiredHoldsLocked(q = db) {
  const expiredSeats = await q.query(`
    UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE status = 'held' AND hold_expires_at <= now()
     RETURNING id
  `);

  await q.query(`
    UPDATE holds
       SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now()
  `);

  const seatIds = expiredSeats.rows.map((r) => r.id);
  return seatIds;
}

async function sweepAndBroadcast() {
  const releasedSeatIds = await withWriteLock(() => tx((q) => sweepExpiredHoldsLocked(q)));
  if (releasedSeatIds.length) {
    broadcast('seats', { type: 'released', seatIds: releasedSeatIds, seats: await getSeatsNoSweepByIds(releasedSeatIds) });
  }
  return releasedSeatIds;
}

async function getSeatsNoSweepByIds(ids) {
  if (!ids.length) return [];
  const result = await db.query(
    `SELECT * FROM seats WHERE id = ANY($1::text[]) ORDER BY row_label, seat_number`,
    [ids],
  );
  return result.rows.map(publicSeat);
}

async function getAllSeats() {
  await sweepAndBroadcast();
  const result = await db.query('SELECT * FROM seats ORDER BY row_label, seat_number');
  return result.rows.map(publicSeat);
}

async function inventory() {
  await sweepAndBroadcast();
  const result = await db.query(`
    SELECT status, COUNT(*)::int AS count
      FROM seats
     GROUP BY status
  `);
  const counts = { available: 0, held: 0, booked: 0, total: ROWS.length * SEATS_PER_ROW };
  for (const row of result.rows) counts[row.status] = Number(row.count);
  return counts;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', async (_req, res, next) => {
  try {
    res.json({ ok: true, inventory: await inventory() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    res.json({ seats: await getAllSeats(), inventory: await inventory(), holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  clients.add(res);
  res.write(`event: hello\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const ids = [...new Set(Array.isArray(seatIds) ? seatIds.map(String) : [])];
    const cleanSessionId = String(sessionId || '').trim();

    if (!cleanSessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!ids.length) return res.status(400).json({ error: 'seatIds must contain at least one seat id' });

    const result = await withWriteLock(() => tx(async (q) => {
      const expired = await sweepExpiredHoldsLocked(q);

      const rows = await q.query('SELECT id, status FROM seats WHERE id = ANY($1::text[])', [ids]);
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      const conflicts = ids.filter((id) => !byId.has(id) || byId.get(id).status !== 'available');
      if (conflicts.length) return { conflict: true, conflicts, expired };

      const holdId = randomUUID();
      const bookingId = randomUUID();
      const expires = await q.query(
        `INSERT INTO holds (id, session_id, expires_at, status, booking_id)
         VALUES ($1, $2, now() + ($3::text)::interval, 'active', $4)
         RETURNING id, session_id, expires_at, status, booking_id`,
        [holdId, cleanSessionId, `${HOLD_TTL_SECONDS} seconds`, bookingId],
      );
      const hold = expires.rows[0];

      const updated = await q.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id = ANY($3::text[]) AND status = 'available'
          RETURNING *`,
        [holdId, hold.expires_at, ids],
      );

      if (updated.rows.length !== ids.length) {
        throw Object.assign(new Error('atomic hold update failed'), { statusCode: 409 });
      }

      return {
        hold: {
          id: hold.id,
          sessionId: hold.session_id,
          seatIds: ids,
          expiresAt: isoFromDb(hold.expires_at),
          status: hold.status,
        },
        seats: updated.rows.map(publicSeat),
        expired,
      };
    }));

    if (result.expired?.length) {
      broadcast('seats', { type: 'released', seatIds: result.expired, seats: await getSeatsNoSweepByIds(result.expired) });
    }

    if (result.conflict) {
      return res.status(409).json({ error: 'one or more seats are unavailable', conflictingSeatIds: result.conflicts });
    }

    broadcast('seats', { type: 'held', hold: result.hold, seatIds: result.hold.seatIds, seats: result.seats });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '');
    const sessionId = String((req.body || {}).sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await withWriteLock(() => tx(async (q) => {
      const expired = await sweepExpiredHoldsLocked(q);
      const holdRows = await q.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (!holdRows.rows.length) return { error: 'unknown hold', statusCode: 404, expired };
      const hold = holdRows.rows[0];
      if (hold.session_id !== sessionId) return { error: 'hold belongs to a different session', statusCode: 403, expired };

      if (hold.status === 'confirmed') {
        const booked = await q.query('SELECT * FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY row_label, seat_number', [holdId, 'booked']);
        return {
          idempotent: true,
          expired,
          booking: { id: hold.booking_id, holdId, seatIds: booked.rows.map((r) => r.id), confirmedAt: isoFromDb(hold.confirmed_at) },
          seats: booked.rows.map(publicSeat),
        };
      }

      if (hold.status !== 'active') return { error: `hold is ${hold.status}`, statusCode: 409, expired };
      if (new Date(hold.expires_at).getTime() <= Date.now()) return { error: 'hold has expired', statusCode: 409, expired };

      const heldSeats = await q.query('SELECT * FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY row_label, seat_number', [holdId, 'held']);
      if (!heldSeats.rows.length) return { error: 'hold owns no active seats', statusCode: 409, expired };

      const booked = await q.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2
          WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now()
          RETURNING *`,
        [holdId, sessionId],
      );

      if (booked.rows.length !== heldSeats.rows.length) throw Object.assign(new Error('confirm race detected'), { statusCode: 409 });

      const updatedHold = await q.query(
        `UPDATE holds SET status = 'confirmed', confirmed_at = now()
          WHERE id = $1 RETURNING *`,
        [holdId],
      );
      const h = updatedHold.rows[0];
      return {
        expired,
        booking: { id: h.booking_id, holdId, seatIds: booked.rows.map((r) => r.id), confirmedAt: isoFromDb(h.confirmed_at) },
        seats: booked.rows.map(publicSeat),
      };
    }));

    if (result.expired?.length) {
      broadcast('seats', { type: 'released', seatIds: result.expired, seats: await getSeatsNoSweepByIds(result.expired) });
    }
    if (result.error) return res.status(result.statusCode).json({ error: result.error });

    if (!result.idempotent) {
      broadcast('seats', { type: 'booked', booking: result.booking, seatIds: result.booking.seatIds, seats: result.seats });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '');
    const sessionId = String((req.body || {}).sessionId || req.query.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await withWriteLock(() => tx(async (q) => {
      const expired = await sweepExpiredHoldsLocked(q);
      const holdRows = await q.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (!holdRows.rows.length) return { error: 'unknown hold', statusCode: 404, expired };
      const hold = holdRows.rows[0];
      if (hold.session_id !== sessionId) return { error: 'hold belongs to a different session', statusCode: 403, expired };
      if (hold.status !== 'active') return { error: `hold is ${hold.status}`, statusCode: 409, expired };

      const released = await q.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING *`,
        [holdId],
      );
      await q.query('UPDATE holds SET status = $2 WHERE id = $1', [holdId, 'released']);
      return { expired, seatIds: released.rows.map((r) => r.id), seats: released.rows.map(publicSeat) };
    }));

    if (result.expired?.length) {
      broadcast('seats', { type: 'released', seatIds: result.expired, seats: await getSeatsNoSweepByIds(result.expired) });
    }
    if (result.error) return res.status(result.statusCode).json({ error: result.error });

    if (result.seatIds.length) broadcast('seats', { type: 'released', seatIds: result.seatIds, seats: result.seats });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || 'internal server error' });
});

await initDb();
setInterval(() => sweepAndBroadcast().catch((err) => console.error('expiry sweep failed', err)), 1000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
