import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30000);
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pglite-data');

const db = new PGlite(DB_DIR);
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'public')));

const clients = new Set();
let writeQueue = Promise.resolve();
function serialize(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

function isoNow() { return new Date().toISOString(); }
function isoPlus(ms) { return new Date(Date.now() + ms).toISOString(); }
function rowId(row, n) { return `${row}-${n}`; }
function publicSeat(row) {
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
function parseSeatIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return JSON.parse(value);
  return [];
}
function publicHold(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    seatIds: parseSeatIds(row.seat_ids),
    expiresAt: row.expires_at,
    status: row.status,
    confirmedAt: row.confirmed_at,
    bookingId: row.booking_id
  };
}

async function tx(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch {}
    throw err;
  }
}

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}

function broadcastSeatUpdates(seats, reason = 'update') {
  if (!seats || seats.length === 0) return;
  const payload = { reason, seats: seats.map(publicSeat), inventory: null };
  broadcast('seats', payload);
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available','held','booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','confirmed','released','expired')),
      confirmed_at TIMESTAMPTZ,
      booking_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_holds_status_exp ON holds(status, expires_at);`);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    for (const r of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        await db.query(
          'INSERT INTO seats (id,row_label,seat_number,status) VALUES ($1,$2,$3,$4)',
          [rowId(r, n), r, n, 'available']
        );
      }
    }
  }
}

async function sweepExpiredInTx() {
  const now = isoNow();
  const expiredSeats = await db.query(
    `UPDATE seats
       SET status='available', hold_id=NULL, hold_expires_at=NULL
     WHERE status='held' AND hold_expires_at <= $1
     RETURNING *`,
    [now]
  );
  await db.query(
    `UPDATE holds SET status='expired'
     WHERE status='active' AND expires_at <= $1`,
    [now]
  );
  return expiredSeats.rows;
}

async function sweepExpired() {
  return serialize(async () => {
    const released = await tx(() => sweepExpiredInTx());
    broadcastSeatUpdates(released, 'expired');
    return released;
  });
}

async function inventory() {
  const now = isoNow();
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='available' OR (status='held' AND hold_expires_at <= $1))::int AS available,
       COUNT(*) FILTER (WHERE status='held' AND hold_expires_at > $1)::int AS held,
       COUNT(*) FILTER (WHERE status='booked')::int AS booked
     FROM seats`,
    [now]
  );
  return result.rows[0];
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/seats', async (req, res, next) => {
  try {
    await sweepExpired();
    const result = await db.query(
      `SELECT * FROM seats
       ORDER BY row_label ASC, seat_number ASC`
    );
    const inv = await inventory();
    res.json({ seats: result.rows.map(publicSeat), inventory: inv, holdTtlMs: HOLD_TTL_MS });
  } catch (err) { next(err); }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const uniqueSeatIds = [...new Set(Array.isArray(seatIds) ? seatIds : [])].filter(x => typeof x === 'string');
    if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: 'sessionId is required' });
    if (uniqueSeatIds.length === 0) return res.status(400).json({ error: 'seatIds must be a non-empty array' });

    const outcome = await serialize(async () => tx(async () => {
      const released = await sweepExpiredInTx();
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(',');
      const existing = await db.query(`SELECT * FROM seats WHERE id IN (${placeholders})`, uniqueSeatIds);
      const found = new Set(existing.rows.map(r => r.id));
      const conflicts = uniqueSeatIds.filter(id => !found.has(id));
      for (const seat of existing.rows) {
        if (seat.status !== 'available') conflicts.push(seat.id);
      }
      if (conflicts.length > 0 || existing.rows.length !== uniqueSeatIds.length) {
        return { ok: false, status: 409, conflicts: [...new Set(conflicts)], released };
      }
      const holdId = crypto.randomUUID();
      const expiresAt = isoPlus(HOLD_TTL_MS);
      const seatJson = JSON.stringify(uniqueSeatIds);
      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [holdId, sessionId, seatJson, expiresAt]
      );
      const updated = await db.query(
        `UPDATE seats SET status='held', hold_id=$1, hold_expires_at=$2
         WHERE id IN (${uniqueSeatIds.map((_, i) => `$${i + 3}`).join(',')}) AND status='available'
         RETURNING *`,
        [holdId, expiresAt, ...uniqueSeatIds]
      );
      if (updated.rows.length !== uniqueSeatIds.length) throw new Error('Atomic hold acquisition failed');
      const holdRes = await db.query('SELECT * FROM holds WHERE id=$1', [holdId]);
      return { ok: true, hold: holdRes.rows[0], seats: updated.rows, released };
    }));

    broadcastSeatUpdates(outcome.released, 'expired');
    if (!outcome.ok) return res.status(outcome.status).json({ error: 'One or more seats are unavailable', conflictingSeatIds: outcome.conflicts });
    broadcastSeatUpdates(outcome.seats, 'held');
    res.status(201).json({ hold: publicHold(outcome.hold), seats: outcome.seats.map(publicSeat) });
  } catch (err) { next(err); }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    const { holdId } = req.params;
    if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: 'sessionId is required' });

    const outcome = await serialize(async () => tx(async () => {
      const released = await sweepExpiredInTx();
      const holdRes = await db.query('SELECT * FROM holds WHERE id=$1', [holdId]);
      if (holdRes.rows.length === 0) return { ok: false, status: 404, error: 'Unknown hold', released };
      const hold = holdRes.rows[0];
      if (hold.session_id !== sessionId) return { ok: false, status: 403, error: 'Hold belongs to a different session', released };
      if (hold.status === 'confirmed') {
        const seatIdsForConfirmedHold = parseSeatIds(hold.seat_ids);
        const seats = await db.query(
          `SELECT * FROM seats WHERE id IN (${seatIdsForConfirmedHold.map((_, i) => `$${i + 1}`).join(',')}) ORDER BY row_label, seat_number`,
          seatIdsForConfirmedHold
        );
        return { ok: true, idempotent: true, hold, seats: seats.rows, released };
      }
      if (hold.status !== 'active') return { ok: false, status: 409, error: `Hold is ${hold.status}`, released };
      if (new Date(hold.expires_at).getTime() <= Date.now()) return { ok: false, status: 409, error: 'Hold has expired', released };
      const seatIdsForHold = parseSeatIds(hold.seat_ids);
      const current = await db.query(
        `SELECT * FROM seats WHERE id IN (${seatIdsForHold.map((_, i) => `$${i + 1}`).join(',')})`,
        seatIdsForHold
      );
      if (current.rows.length !== seatIdsForHold.length || current.rows.some(s => s.status !== 'held' || s.hold_id !== holdId)) {
        return { ok: false, status: 409, error: 'Hold no longer owns all seats', released };
      }
      const bookingId = hold.booking_id || crypto.randomUUID();
      const booked = await db.query(
        `UPDATE seats SET status='booked', booked_by=$1, hold_id=NULL, hold_expires_at=NULL
         WHERE hold_id=$2 AND status='held'
         RETURNING *`,
        [sessionId, holdId]
      );
      await db.query(
        `UPDATE holds SET status='confirmed', confirmed_at=$1, booking_id=$2 WHERE id=$3`,
        [isoNow(), bookingId, holdId]
      );
      const newHold = await db.query('SELECT * FROM holds WHERE id=$1', [holdId]);
      return { ok: true, hold: newHold.rows[0], seats: booked.rows, released };
    }));

    broadcastSeatUpdates(outcome.released, 'expired');
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    if (!outcome.idempotent) broadcastSeatUpdates(outcome.seats, 'booked');
    res.json({ hold: publicHold(outcome.hold), bookingId: outcome.hold.booking_id, seats: outcome.seats.map(publicSeat), idempotent: !!outcome.idempotent });
  } catch (err) { next(err); }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    const { holdId } = req.params;
    const outcome = await serialize(async () => tx(async () => {
      const releasedExpired = await sweepExpiredInTx();
      const holdRes = await db.query('SELECT * FROM holds WHERE id=$1', [holdId]);
      if (holdRes.rows.length === 0) return { ok: false, status: 404, error: 'Unknown hold', releasedExpired };
      const hold = holdRes.rows[0];
      if (sessionId && hold.session_id !== sessionId) return { ok: false, status: 403, error: 'Hold belongs to a different session', releasedExpired };
      if (hold.status !== 'active') return { ok: true, releasedSeats: [], releasedExpired, hold };
      const releasedSeats = await db.query(
        `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL
         WHERE hold_id=$1 AND status='held'
         RETURNING *`,
        [holdId]
      );
      await db.query(`UPDATE holds SET status='released' WHERE id=$1`, [holdId]);
      const newHold = await db.query('SELECT * FROM holds WHERE id=$1', [holdId]);
      return { ok: true, releasedSeats: releasedSeats.rows, releasedExpired, hold: newHold.rows[0] };
    }));
    broadcastSeatUpdates(outcome.releasedExpired, 'expired');
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    broadcastSeatUpdates(outcome.releasedSeats, 'released');
    res.json({ hold: publicHold(outcome.hold), releasedSeatIds: outcome.releasedSeats.map(s => s.id) });
  } catch (err) { next(err); }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ now: isoNow() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

await initDb();
setInterval(() => sweepExpired().catch(err => console.error('expiry sweep failed', err)), 1000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
