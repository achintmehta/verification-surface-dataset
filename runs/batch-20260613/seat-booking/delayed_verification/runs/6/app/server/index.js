import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3001;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const DB_DIR = process.env.PGLITE_DATA_DIR || './data/pglite';

await mkdir(DB_DIR, { recursive: true });
const db = new PGlite(DB_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: '128kb' }));

const clients = new Set();
let transactionChain = Promise.resolve();

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: toIso(row.hold_expires_at),
    bookedBy: row.booked_by,
  };
}

function normalizeInventory(row) {
  return {
    total: Number(row.total),
    available: Number(row.available),
    held: Number(row.held),
    booked: Number(row.booked),
  };
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

async function exec(sql) {
  return db.exec(sql);
}

async function withTransaction(fn) {
  const run = transactionChain.then(async () => {
    await exec('BEGIN');
    try {
      const result = await fn();
      await exec('COMMIT');
      return result;
    } catch (err) {
      try { await exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  });
  transactionChain = run.catch(() => {});
  return run;
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(message); } catch (_) { clients.delete(res); }
  }
}

async function initDb() {
  await exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      held_by TEXT,
      booked_by TEXT,
      booked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND held_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND held_by IS NOT NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT[] NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      booking_id TEXT,
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_status_expires ON holds(status, expires_at);
  `);

  const count = await query('SELECT count(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        await query('INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)', [`${row}${n}`, row, n, 'available']);
      }
    }
  }
}

async function getInventory() {
  const result = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'available' OR (status = 'held' AND hold_expires_at <= now()))::int AS available,
      count(*) FILTER (WHERE status = 'held' AND hold_expires_at > now())::int AS held,
      count(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  return normalizeInventory(result.rows[0]);
}

async function getSeatsByIds(seatIds) {
  if (!seatIds.length) return [];
  const result = await query('SELECT * FROM seats WHERE id = ANY($1::text[]) ORDER BY row_label, seat_number', [seatIds]);
  return result.rows.map(normalizeSeat);
}

async function sweepExpiredHolds({ inTransaction = false } = {}) {
  const work = async () => {
    const expired = await query(`
      SELECT id, seat_ids
      FROM holds
      WHERE status = 'active' AND expires_at <= now()
      ORDER BY id
      FOR UPDATE
    `);
    if (expired.rows.length === 0) return [];

    const expiredIds = expired.rows.map((h) => h.id);
    const releasedSeatIds = [...new Set(expired.rows.flatMap((h) => h.seat_ids || []))];

    await query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL, updated_at = now()
      WHERE status = 'held' AND hold_id = ANY($1::text[])
    `, [expiredIds]);
    await query(`
      UPDATE holds
      SET status = 'expired', updated_at = now()
      WHERE id = ANY($1::text[])
    `, [expiredIds]);
    return releasedSeatIds;
  };

  const releasedSeatIds = inTransaction ? await work() : await withTransaction(work);
  if (!inTransaction) await replayExpiredBroadcast(releasedSeatIds);
  return releasedSeatIds;
}

async function listSeats() {
  await sweepExpiredHolds();
  const result = await query('SELECT * FROM seats ORDER BY row_label, seat_number');
  return result.rows.map(normalizeSeat);
}

async function getSeatSnapshot() {
  const seats = await listSeats();
  return { seats, inventory: await getInventory(), holdTtlMs: HOLD_TTL_MS };
}

function replayExpiredBroadcast(expiredSeatIds) {
  if (!expiredSeatIds.length) return Promise.resolve();
  return getSeatsByIds(expiredSeatIds).then(async (seats) => {
    broadcast('seats', { type: 'released', seats, inventory: await getInventory() });
  });
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/seats', async (_req, res, next) => {
  try { res.json(await getSeatSnapshot()); } catch (err) { next(err); }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');
  clients.add(res);
  try {
    res.write(`event: snapshot\ndata: ${JSON.stringify(await getSeatSnapshot())}\n\n`);
  } catch (_) {
    res.write(`event: error\ndata: {"error":"snapshot_failed"}\n\n`);
  }
  req.on('close', () => clients.delete(res));
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    if (!Array.isArray(seatIds) || seatIds.length === 0) return badRequest(res, 'seatIds must be a non-empty array');
    if (!sessionId || typeof sessionId !== 'string') return badRequest(res, 'sessionId is required');

    const uniqueSeatIds = [...new Set(seatIds.map(String))];
    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
    let expiredSeatIds = [];

    const result = await withTransaction(async () => {
      expiredSeatIds = await sweepExpiredHolds({ inTransaction: true });
      const existing = await query(`
        SELECT id, status FROM seats
        WHERE id = ANY($1::text[])
        ORDER BY id
        FOR UPDATE
      `, [uniqueSeatIds]);

      const foundIds = new Set(existing.rows.map((r) => r.id));
      const missing = uniqueSeatIds.filter((id) => !foundIds.has(id));
      const unavailable = existing.rows.filter((r) => r.status !== 'available').map((r) => r.id);
      const conflicts = [...new Set([...missing, ...unavailable])];
      if (conflicts.length || existing.rows.length !== uniqueSeatIds.length) return { ok: false, conflicts };

      await query(`
        INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
        VALUES ($1, $2, $3::text[], $4::timestamptz, 'active')
      `, [holdId, sessionId, uniqueSeatIds, expiresAt]);

      const updated = await query(`
        UPDATE seats
        SET status = 'held', hold_id = $1, hold_expires_at = $2::timestamptz, held_by = $3, updated_at = now()
        WHERE id = ANY($4::text[]) AND status = 'available'
      `, [holdId, expiresAt, sessionId, uniqueSeatIds]);
      if (updated.affectedRows !== undefined && updated.affectedRows !== uniqueSeatIds.length) throw new Error('failed to hold every requested seat');

      const seats = await getSeatsByIds(uniqueSeatIds);
      return { ok: true, hold: { id: holdId, sessionId, seatIds: uniqueSeatIds, expiresAt, status: 'active' }, seats };
    });

    await replayExpiredBroadcast(expiredSeatIds);
    if (!result.ok) return res.status(409).json({ error: 'seats_unavailable', conflicts: result.conflicts });

    const inventory = await getInventory();
    broadcast('seats', { type: 'held', hold: result.hold, seats: result.seats, inventory });
    res.status(201).json({ hold: result.hold, seats: result.seats, inventory });
  } catch (err) { next(err); }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.body?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') return badRequest(res, 'sessionId is required');
    let expiredSeatIds = [];

    const result = await withTransaction(async () => {
      expiredSeatIds = await sweepExpiredHolds({ inTransaction: true });
      const holdResult = await query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [holdId]);
      if (!holdResult.rows.length) return { ok: false, status: 404, error: 'unknown_hold' };
      const hold = holdResult.rows[0];
      if (hold.session_id !== sessionId) return { ok: false, status: 403, error: 'wrong_session' };

      if (hold.status === 'confirmed') {
        const seats = await getSeatsByIds(hold.seat_ids || []);
        return { ok: true, alreadyConfirmed: true, booking: { id: hold.booking_id, holdId, sessionId, seatIds: hold.seat_ids || [], confirmedAt: toIso(hold.confirmed_at) }, seats };
      }
      if (hold.status !== 'active') return { ok: false, status: 409, error: `hold_${hold.status}` };

      const ownedSeats = await query(`
        SELECT id FROM seats
        WHERE id = ANY($1::text[]) AND status = 'held' AND hold_id = $2
        ORDER BY id
        FOR UPDATE
      `, [hold.seat_ids || [], holdId]);
      if (ownedSeats.rows.length !== (hold.seat_ids || []).length) return { ok: false, status: 409, error: 'hold_not_active' };

      const bookingId = randomUUID();
      const confirmedAt = new Date().toISOString();
      const updated = await query(`
        UPDATE seats
        SET status = 'booked', booked_by = $1, booked_at = $2::timestamptz,
            hold_id = NULL, hold_expires_at = NULL, held_by = NULL, updated_at = now()
        WHERE id = ANY($3::text[]) AND status = 'held' AND hold_id = $4
      `, [sessionId, confirmedAt, hold.seat_ids || [], holdId]);
      if (updated.affectedRows !== undefined && updated.affectedRows !== (hold.seat_ids || []).length) throw new Error('failed to book every held seat');

      await query(`
        UPDATE holds
        SET status = 'confirmed', booking_id = $1, confirmed_at = $2::timestamptz, updated_at = now()
        WHERE id = $3
      `, [bookingId, confirmedAt, holdId]);

      const seats = await getSeatsByIds(hold.seat_ids || []);
      return { ok: true, alreadyConfirmed: false, booking: { id: bookingId, holdId, sessionId, seatIds: hold.seat_ids || [], confirmedAt }, seats };
    });

    await replayExpiredBroadcast(expiredSeatIds);
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const inventory = await getInventory();
    if (!result.alreadyConfirmed) broadcast('seats', { type: 'booked', booking: result.booking, seats: result.seats, inventory });
    res.json({ booking: result.booking, seats: result.seats, inventory, idempotent: result.alreadyConfirmed });
  } catch (err) { next(err); }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.body?.sessionId || req.query.sessionId;
    if (!sessionId || typeof sessionId !== 'string') return badRequest(res, 'sessionId is required');
    let expiredSeatIds = [];

    const result = await withTransaction(async () => {
      expiredSeatIds = await sweepExpiredHolds({ inTransaction: true });
      const holdResult = await query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [holdId]);
      if (!holdResult.rows.length) return { ok: false, status: 404, error: 'unknown_hold' };
      const hold = holdResult.rows[0];
      if (hold.session_id !== sessionId) return { ok: false, status: 403, error: 'wrong_session' };
      if (hold.status !== 'active') return { ok: true, released: false, seats: await getSeatsByIds(hold.seat_ids || []) };

      await query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, held_by = NULL, updated_at = now()
        WHERE status = 'held' AND hold_id = $1
      `, [holdId]);
      await query('UPDATE holds SET status = $1, updated_at = now() WHERE id = $2', ['released', holdId]);
      return { ok: true, released: true, seats: await getSeatsByIds(hold.seat_ids || []) };
    });

    await replayExpiredBroadcast(expiredSeatIds);
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const inventory = await getInventory();
    if (result.released) broadcast('seats', { type: 'released', holdId, seats: result.seats, inventory });
    res.json({ released: result.released, seats: result.seats, inventory });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

await initDb();
await sweepExpiredHolds();
const sweepTimer = setInterval(() => sweepExpiredHolds().catch((err) => console.error('expiry sweep failed', err)), 1000);
sweepTimer.unref?.();

app.listen(PORT, () => console.log(`Seat booking API listening on http://localhost:${PORT}`));
