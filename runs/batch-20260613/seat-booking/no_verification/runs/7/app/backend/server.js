import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const TOTAL_SEATS = ROWS.length * SEATS_PER_ROW;

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const db = new PGlite(process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite'));

// PGlite is embedded in this process. Serializing business transactions avoids
// interleaved multi-statement handlers and gives all-or-nothing behavior under
// many concurrent HTTP requests.
let dbQueue = Promise.resolve();
async function withDbTx(fn) {
  const previous = dbQueue;
  let release;
  dbQueue = new Promise((resolve) => (release = resolve));
  await previous;
  try {
    await db.query('BEGIN');
    try {
      const result = await fn();
      await db.query('COMMIT');
      return result;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    release();
  }
}

const clients = new Set();
const nowIso = () => new Date().toISOString();
const plusSecondsIso = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const placeholders = (start, count) => Array.from({ length: count }, (_, i) => `$${start + i}`).join(',');

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) return null;
  const ids = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toUpperCase();
    if (!/^[A-Z]-\d+$/.test(id)) return null;
    if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }
  return ids;
}

function parseSeat(row) {
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

function inventoryFromRows(rows) {
  return rows.reduce((acc, seat) => {
    acc.total += 1;
    acc[seat.status] += 1;
    return acc;
  }, { total: 0, available: 0, held: 0, booked: 0 });
}

async function fetchAllSeats() {
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats
     ORDER BY row_label, seat_number
  `);
  return result.rows.map(parseSeat);
}

async function broadcast(type, payload = {}) {
  let seats = payload.seats;
  if (!seats) seats = await fetchAllSeats();
  const inventory = payload.inventory || (seats.length === TOTAL_SEATS ? inventoryFromRows(seats) : undefined);
  const data = JSON.stringify({ type, at: nowIso(), ...payload, seats, ...(inventory ? { inventory } : {}) });
  for (const res of clients) {
    res.write('event: seats\n');
    res.write(`data: ${data}\n\n`);
  }
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL) OR
        (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL) OR
        (status = 'booked' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NOT NULL)
      )
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'booked', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ NULL,
      booking_id TEXT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
      seat_id TEXT NOT NULL REFERENCES seats(id),
      PRIMARY KEY (hold_id, seat_id)
    )
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [`${row}-${n}`, row, n]
        );
      }
    }
  }
}

async function sweepExpiredHoldsTx() {
  const expired = await db.query(`
    SELECT id, hold_id
      FROM seats
     WHERE status = 'held'
       AND hold_expires_at <= now()
     ORDER BY id
  `);
  if (expired.rows.length === 0) return [];

  await db.query(`UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at <= now()`);
  await db.query(`
    UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE status = 'held'
       AND hold_expires_at <= now()
  `);

  return expired.rows.map((row) => ({
    id: row.id,
    status: 'available',
    holdId: null,
    holdExpiresAt: null,
    bookedBy: null,
    previousHoldId: row.hold_id,
  }));
}

async function sweepExpiredAndBroadcast() {
  const released = await withDbTx(() => sweepExpiredHoldsTx());
  if (released.length) await broadcast('expired', { seats: released });
}

app.get('/api/health', async (_req, res, next) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const outcome = await withDbTx(async () => {
      const released = await sweepExpiredHoldsTx();
      const seats = await fetchAllSeats();
      return { released, seats, inventory: inventoryFromRows(seats) };
    });
    if (outcome.released.length) await broadcast('expired', { seats: outcome.released });
    res.json({ seats: outcome.seats, inventory: outcome.inventory, holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!seatIds || seatIds.length === 0 || !sessionId) {
      return res.status(400).json({ error: 'seatIds (non-empty array) and sessionId are required' });
    }

    const outcome = await withDbTx(async () => {
      const released = await sweepExpiredHoldsTx();
      const selected = await db.query(
        `SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${placeholders(1, seatIds.length)}) ORDER BY id`,
        seatIds
      );

      if (selected.rows.length !== seatIds.length) {
        const found = new Set(selected.rows.map((row) => row.id));
        return { status: 400, body: { error: 'Unknown seat ids', unknownSeatIds: seatIds.filter((id) => !found.has(id)) }, released };
      }

      const conflicts = selected.rows.filter((row) => row.status !== 'available').map((row) => ({
        id: row.id,
        status: row.status,
        holdId: row.hold_id,
        holdExpiresAt: row.hold_expires_at,
        bookedBy: row.booked_by,
      }));
      if (conflicts.length) {
        return { status: 409, body: { error: 'One or more seats are unavailable', conflictingSeatIds: conflicts.map((s) => s.id), conflicts }, released };
      }

      const holdId = randomUUID();
      const expiresAt = plusSecondsIso(HOLD_TTL_SECONDS);
      await db.query(`INSERT INTO holds (id, session_id, status, expires_at) VALUES ($1, $2, 'active', $3)`, [holdId, sessionId, expiresAt]);
      for (const seatId of seatIds) {
        await db.query(`INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)`, [holdId, seatId]);
      }
      await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${placeholders(3, seatIds.length)})
            AND status = 'available'`,
        [holdId, expiresAt, ...seatIds]
      );

      const heldRows = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${placeholders(1, seatIds.length)}) ORDER BY id`,
        seatIds
      );
      const heldSeats = heldRows.rows.map(parseSeat);
      return {
        status: 201,
        body: { hold: { id: holdId, sessionId, seatIds, expiresAt, ttlSeconds: HOLD_TTL_SECONDS }, seats: heldSeats },
        broadcast: { type: 'held', seats: heldSeats },
        released,
      };
    });

    if (outcome.released?.length) await broadcast('expired', { seats: outcome.released });
    if (outcome.broadcast) await broadcast(outcome.broadcast.type, { seats: outcome.broadcast.seats, hold: outcome.body.hold });
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const suppliedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';

    const outcome = await withDbTx(async () => {
      const released = await sweepExpiredHoldsTx();
      const holdResult = await db.query(`SELECT * FROM holds WHERE id = $1`, [holdId]);
      if (holdResult.rows.length === 0) return { status: 404, body: { error: 'Unknown hold' }, released };
      const hold = holdResult.rows[0];
      if (suppliedSessionId && suppliedSessionId !== hold.session_id) return { status: 403, body: { error: 'Hold belongs to a different session' }, released };

      const seatRows = await db.query(
        `SELECT s.id, s.row_label, s.seat_number, s.status, s.hold_id, s.hold_expires_at, s.booked_by
           FROM hold_seats hs JOIN seats s ON s.id = hs.seat_id
          WHERE hs.hold_id = $1 ORDER BY s.id`,
        [holdId]
      );
      const seatIds = seatRows.rows.map((row) => row.id);

      if (hold.status === 'booked') {
        return {
          status: 200,
          body: { booking: { id: hold.booking_id, holdId, sessionId: hold.session_id, seatIds, confirmedAt: hold.confirmed_at }, seats: seatRows.rows.map(parseSeat), idempotent: true },
          released,
        };
      }
      if (hold.status !== 'active') return { status: 409, body: { error: `Hold is ${hold.status}` }, released };
      if (seatRows.rows.length === 0) return { status: 409, body: { error: 'Hold has no seats' }, released };

      const invalidSeats = seatRows.rows.filter((row) => row.status !== 'held' || row.hold_id !== holdId);
      if (invalidSeats.length) {
        return { status: 409, body: { error: 'Hold is no longer active for all seats', conflictingSeatIds: invalidSeats.map((s) => s.id) }, released };
      }

      const bookingId = randomUUID();
      const confirmedAt = nowIso();
      await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $2
            AND status = 'held'`,
        [hold.session_id, holdId]
      );
      await db.query(`UPDATE holds SET status = 'booked', confirmed_at = $2, booking_id = $1 WHERE id = $3`, [bookingId, confirmedAt, holdId]);
      const bookedRows = await db.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${placeholders(1, seatIds.length)}) ORDER BY id`,
        seatIds
      );
      const bookedSeats = bookedRows.rows.map(parseSeat);
      return {
        status: 200,
        body: { booking: { id: bookingId, holdId, sessionId: hold.session_id, seatIds, confirmedAt }, seats: bookedSeats },
        broadcast: { type: 'booked', seats: bookedSeats },
        released,
      };
    });

    if (outcome.released?.length) await broadcast('expired', { seats: outcome.released });
    if (outcome.broadcast) await broadcast(outcome.broadcast.type, { seats: outcome.broadcast.seats, booking: outcome.body.booking });
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const suppliedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const outcome = await withDbTx(async () => {
      const releasedByExpiry = await sweepExpiredHoldsTx();
      const holdResult = await db.query(`SELECT * FROM holds WHERE id = $1`, [holdId]);
      if (holdResult.rows.length === 0) return { status: 404, body: { error: 'Unknown hold' }, releasedByExpiry };
      const hold = holdResult.rows[0];
      if (suppliedSessionId && suppliedSessionId !== hold.session_id) return { status: 403, body: { error: 'Hold belongs to a different session' }, releasedByExpiry };
      if (hold.status === 'booked') return { status: 409, body: { error: 'Booked holds cannot be released' }, releasedByExpiry };
      if (hold.status !== 'active') return { status: 200, body: { released: false, status: hold.status }, releasedByExpiry };

      const affected = await db.query(`SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY id`, [holdId]);
      await db.query(`UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1 AND status = 'held'`, [holdId]);
      await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
      const released = affected.rows.map((row) => ({ id: row.id, status: 'available', holdId: null, holdExpiresAt: null, bookedBy: null }));
      return { status: 200, body: { released: true, holdId, seatIds: released.map((s) => s.id) }, released, releasedByExpiry };
    });

    if (outcome.releasedByExpiry?.length) await broadcast('expired', { seats: outcome.releasedByExpiry });
    if (outcome.released?.length) await broadcast('released', { seats: outcome.released, holdId });
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    clients.add(res);

    const snapshot = await withDbTx(async () => {
      const released = await sweepExpiredHoldsTx();
      const seats = await fetchAllSeats();
      return { released, seats };
    });
    if (snapshot.released.length) await broadcast('expired', { seats: snapshot.released });

    res.write('event: seats\n');
    res.write(`data: ${JSON.stringify({ type: 'snapshot', at: nowIso(), seats: snapshot.seats, inventory: inventoryFromRows(snapshot.seats) })}\n\n`);

    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  } catch (err) {
    next(err);
  }
});

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend not built. Run npm run client:dev during development.');
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

await initDb();
setInterval(() => sweepExpiredAndBroadcast().catch((err) => console.error('expiry sweep failed', err)), 1000);

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`Hold TTL: ${HOLD_TTL_SECONDS}s, seats: ${TOTAL_SEATS}`);
});
