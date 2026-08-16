import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data', 'pglite');
mkdirSync(dataDir, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

app.use(cors());
app.use(express.json());
app.use(express.static(join(rootDir, 'public')));

const db = new PGlite(dataDir);
const clients = new Set();
let txQueue = Promise.resolve();

function runExclusive(fn) {
  const run = txQueue.then(fn, fn);
  txQueue = run.catch(() => {});
  return run;
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms).toISOString();
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

function seatEventFromRow(row, status = row.status) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status,
    holdId: status === 'held' ? row.hold_id : null,
    holdExpiresAt: status === 'held' ? row.hold_expires_at : null,
    bookedBy: status === 'booked' ? row.booked_by : null,
  };
}

function broadcast(type, seats, extra = {}) {
  if (!Array.isArray(seats)) seats = [seats];
  if (seats.length === 0) return;
  const payload = JSON.stringify({ type, seats, ...extra, at: new Date().toISOString() });
  for (const res of clients) {
    res.write(`event: seats\n`);
    res.write(`data: ${payload}\n\n`);
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
      confirmed_hold_id TEXT,
      confirmed_at TEXT,
      UNIQUE(row_label, seat_number),
      CHECK ((status = 'held') = (hold_id IS NOT NULL AND hold_expires_at IS NOT NULL)),
      CHECK (status != 'booked' OR booked_by IS NOT NULL)
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_expiry ON seats(hold_expires_at);`);
  await query(`
    CREATE TABLE IF NOT EXISTS hold_records (
      hold_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      released_at TEXT
    );
  `);

  const countRes = await query(`SELECT COUNT(*)::int AS count FROM seats;`);
  const count = Number(countRes.rows[0].count);
  if (count === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        await query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
          [`${row}${n}`, row, n]
        );
      }
    }
  }
}

async function sweepExpiredHolds() {
  return runExclusive(async () => {
    const now = new Date().toISOString();
    const expired = await query(
      `SELECT * FROM seats WHERE status = 'held' AND hold_expires_at <= $1 ORDER BY row_label, seat_number`,
      [now]
    );
    if (expired.rows.length === 0) return [];

    const holdIds = [...new Set(expired.rows.map((r) => r.hold_id).filter(Boolean))];
    const seatIds = expired.rows.map((r) => r.id);
    await query(
      `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL
       WHERE status = 'held' AND hold_expires_at <= $1`,
      [now]
    );
    for (const holdId of holdIds) {
      await query(
        `UPDATE hold_records SET status = 'expired', released_at = COALESCE(released_at, $1)
          WHERE hold_id = $2 AND status = 'active'`,
        [now, holdId]
      );
    }
    const released = expired.rows.map((r) => ({ ...seatEventFromRow(r, 'available'), holdId: null, holdExpiresAt: null }));
    broadcast('released', released, { reason: 'expired', holdIds, seatIds });
    return released;
  });
}

async function seatsSnapshot() {
  await sweepExpiredHolds();
  const result = await query(`SELECT * FROM seats ORDER BY row_label, seat_number`);
  const seats = result.rows.map(normalizeSeat);
  const inventory = seats.reduce(
    (acc, s) => {
      acc[s.status] += 1;
      acc.total += 1;
      return acc;
    },
    { available: 0, held: 0, booked: 0, total: 0 }
  );
  return { seats, inventory };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    res.json(await seatsSnapshot());
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const { seatIds, sessionId } = req.body || {};
    const uniqueSeatIds = [...new Set(Array.isArray(seatIds) ? seatIds.map(String) : [])];
    if (!sessionId || uniqueSeatIds.length === 0) {
      return res.status(400).json({ error: 'sessionId and non-empty seatIds are required' });
    }

    await sweepExpiredHolds();
    const result = await runExclusive(async () => {
      const now = new Date().toISOString();
      const expiresAt = addMs(new Date(), HOLD_TTL_MS);
      const placeholders = uniqueSeatIds.map((_, i) => `$${i + 1}`).join(', ');
      const selected = await query(
        `SELECT * FROM seats WHERE id IN (${placeholders}) ORDER BY row_label, seat_number`,
        uniqueSeatIds
      );
      const selectedIds = new Set(selected.rows.map((r) => r.id));
      const conflicts = [];
      for (const id of uniqueSeatIds) {
        const row = selected.rows.find((r) => r.id === id);
        if (!selectedIds.has(id)) conflicts.push({ id, reason: 'not_found' });
        else if (row.status !== 'available') conflicts.push({ id, reason: row.status, holdId: row.hold_id, holdExpiresAt: row.hold_expires_at });
      }
      if (conflicts.length > 0) {
        return { ok: false, conflicts };
      }

      const holdId = randomUUID();
      await query(
        `INSERT INTO hold_records (hold_id, session_id, seat_ids, expires_at, status, created_at)
         VALUES ($1, $2, $3, $4, 'active', $5)`,
        [holdId, String(sessionId), JSON.stringify(uniqueSeatIds), expiresAt, now]
      );
      const updateParams = [holdId, expiresAt, ...uniqueSeatIds];
      const updatePlaceholders = uniqueSeatIds.map((_, i) => `$${i + 3}`).join(', ');
      const updated = await query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE status = 'available' AND id IN (${updatePlaceholders})
          RETURNING *`,
        updateParams
      );
      if (updated.rows.length !== uniqueSeatIds.length) {
        // This should be unreachable with the exclusive queue, but keeps the all-or-nothing guarantee.
        await query(`DELETE FROM hold_records WHERE hold_id = $1`, [holdId]);
        await query(
          `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL WHERE hold_id = $1`,
          [holdId]
        );
        return { ok: false, conflicts: uniqueSeatIds.map((id) => ({ id, reason: 'race_lost' })) };
      }
      const seats = updated.rows.map((r) => seatEventFromRow(r, 'held'));
      return { ok: true, hold: { holdId, sessionId: String(sessionId), seatIds: uniqueSeatIds, expiresAt, ttlMs: HOLD_TTL_MS }, seats };
    });

    if (!result.ok) {
      return res.status(409).json({ error: 'One or more seats are unavailable', conflicts: result.conflicts });
    }
    broadcast('held', result.seats, { holdId: result.hold.holdId });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId);
    const requestedSessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    await sweepExpiredHolds();
    const result = await runExclusive(async () => {
      const now = new Date().toISOString();
      const holdRes = await query(`SELECT * FROM hold_records WHERE hold_id = $1`, [holdId]);
      if (holdRes.rows.length === 0) return { ok: false, status: 404, error: 'Unknown hold' };
      const hold = holdRes.rows[0];
      if (requestedSessionId && hold.session_id !== requestedSessionId) {
        return { ok: false, status: 403, error: 'Hold belongs to another session' };
      }
      const seatIds = JSON.parse(hold.seat_ids);

      if (hold.status === 'confirmed') {
        const booked = await query(
          `SELECT * FROM seats WHERE confirmed_hold_id = $1 OR hold_id = $1 ORDER BY row_label, seat_number`,
          [holdId]
        );
        return {
          ok: true,
          idempotent: true,
          booking: { holdId, sessionId: hold.session_id, seatIds, confirmedAt: hold.confirmed_at, status: 'confirmed' },
          seats: booked.rows.map((r) => seatEventFromRow(r, 'booked')),
        };
      }
      if (hold.status !== 'active' || hold.expires_at <= now) {
        if (hold.status === 'active') {
          await query(`UPDATE hold_records SET status = 'expired', released_at = COALESCE(released_at, $1) WHERE hold_id = $2`, [now, holdId]);
          await query(`UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL WHERE hold_id = $1 AND status = 'held'`, [holdId]);
        }
        return { ok: false, status: 410, error: 'Hold is expired or no longer active' };
      }

      const placeholders = seatIds.map((_, i) => `$${i + 2}`).join(', ');
      const owned = await query(
        `SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' AND id IN (${placeholders}) ORDER BY row_label, seat_number`,
        [holdId, ...seatIds]
      );
      if (owned.rows.length !== seatIds.length) {
        return { ok: false, status: 409, error: 'Hold no longer owns all requested seats' };
      }
      const confirmed = await query(
        `UPDATE seats
           SET status = 'booked', booked_by = $1, booked_at = $2, confirmed_hold_id = $3,
               hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $3 AND status = 'held'
         RETURNING *`,
        [hold.session_id, now, holdId]
      );
      await query(
        `UPDATE hold_records SET status = 'confirmed', confirmed_at = $1 WHERE hold_id = $2`,
        [now, holdId]
      );
      return {
        ok: true,
        idempotent: false,
        booking: { holdId, sessionId: hold.session_id, seatIds, confirmedAt: now, status: 'confirmed' },
        seats: confirmed.rows.map((r) => seatEventFromRow(r, 'booked')),
      };
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (!result.idempotent) broadcast('booked', result.seats, { holdId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId);
    const requestedSessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    await sweepExpiredHolds();
    const result = await runExclusive(async () => {
      const now = new Date().toISOString();
      const holdRes = await query(`SELECT * FROM hold_records WHERE hold_id = $1`, [holdId]);
      if (holdRes.rows.length === 0) return { ok: true, released: [], alreadyGone: true };
      const hold = holdRes.rows[0];
      if (requestedSessionId && hold.session_id !== requestedSessionId) {
        return { ok: false, status: 403, error: 'Hold belongs to another session' };
      }
      if (hold.status !== 'active') return { ok: true, released: [], status: hold.status };
      const held = await query(`SELECT * FROM seats WHERE hold_id = $1 AND status = 'held' ORDER BY row_label, seat_number`, [holdId]);
      await query(`UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL WHERE hold_id = $1 AND status = 'held'`, [holdId]);
      await query(`UPDATE hold_records SET status='released', released_at=$1 WHERE hold_id = $2 AND status = 'active'`, [now, holdId]);
      return { ok: true, released: held.rows.map((r) => seatEventFromRow(r, 'available')) };
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    broadcast('released', result.released, { reason: 'manual', holdId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  clients.add(res);
  try {
    const snapshot = await seatsSnapshot();
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    // Keep stream alive even if initial snapshot fails.
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

setInterval(() => {
  sweepExpiredHolds().catch((err) => console.error('expiry sweep failed', err));
}, Math.max(1000, Math.min(HOLD_TTL_MS / 2, 10_000)));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err) });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
