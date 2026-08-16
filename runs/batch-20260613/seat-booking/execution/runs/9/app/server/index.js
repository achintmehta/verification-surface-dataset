import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DB_PATH);

let lockTail = Promise.resolve();
async function withDbLock(fn) {
  const previous = lockTail;
  let release;
  lockTail = new Promise((resolve) => (release = resolve));
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
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors so callers see the real failure.
    }
    throw err;
  }
}

const clients = new Set();
function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(data);
    } catch (_) {
      clients.delete(client);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}
function addSecondsIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TEXT,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'expired', 'released')),
      booking_id TEXT,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_status_hold ON seats(status, hold_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_holds_status_expires ON holds(status, expires_at)');

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        const id = `${row}${n}`;
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
          [id, row, n, 'available']
        );
      }
    }
  }
}

function seatDto(row) {
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

async function listSeats() {
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows.map(seatDto);
}

async function inventory() {
  const result = await db.query(`
    SELECT status, COUNT(*)::int AS count
    FROM seats
    GROUP BY status
  `);
  const summary = { available: 0, held: 0, booked: 0, total: 0 };
  for (const row of result.rows) {
    summary[row.status] = Number(row.count);
    summary.total += Number(row.count);
  }
  return summary;
}

async function expireHoldsInternal() {
  const now = nowIso();
  const expired = await db.query(
    `SELECT id, seat_ids FROM holds WHERE status = 'active' AND expires_at <= $1`,
    [now]
  );
  const releasedSeatIds = [];
  for (const hold of expired.rows) {
    const seatIds = JSON.parse(hold.seat_ids);
    if (seatIds.length) {
      const updated = await db.query(
        `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id`,
        [hold.id]
      );
      releasedSeatIds.push(...updated.rows.map((r) => r.id));
    }
    await db.query(`UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`, [hold.id]);
  }
  return releasedSeatIds;
}

async function sweepExpiredAndBroadcast() {
  const releasedSeatIds = await withDbLock(async () => tx(expireHoldsInternal));
  if (releasedSeatIds.length) {
    broadcast('seats', { type: 'released', seats: releasedSeatIds.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })) });
  }
  return releasedSeatIds;
}

function validateSeatIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'seatIds must be a non-empty array' };
  }
  const clean = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  if (clean.length === 0) return { ok: false, error: 'seatIds must contain at least one id' };
  if (clean.length !== value.length) return { ok: false, error: 'seatIds must not contain duplicates' };
  return { ok: true, seatIds: clean };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/seats', async (_req, res, next) => {
  try {
    await sweepExpiredAndBroadcast();
    const seats = await listSeats();
    res.json({ seats, inventory: await inventory(), holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const validation = validateSeatIds(req.body?.seatIds);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await withDbLock(async () => tx(async () => {
      const released = await expireHoldsInternal();
      const { seatIds } = validation;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const found = await db.query(
        `SELECT id, status FROM seats WHERE id IN (${placeholders}) ORDER BY id`,
        seatIds
      );
      const foundIds = new Set(found.rows.map((r) => r.id));
      const missing = seatIds.filter((id) => !foundIds.has(id));
      if (missing.length) {
        return { ok: false, status: 404, released, body: { error: 'Unknown seat id(s)', missingSeatIds: missing } };
      }
      const conflicts = found.rows.filter((r) => r.status !== 'available').map((r) => r.id);
      if (conflicts.length) {
        return { ok: false, status: 409, released, body: { error: 'One or more seats are unavailable', conflictingSeatIds: conflicts } };
      }

      const holdId = randomUUID();
      const expiresAt = addSecondsIso(HOLD_TTL_SECONDS);
      const createdAt = nowIso();
      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at, status, created_at)
         VALUES ($1, $2, $3, $4, 'active', $5)`,
        [holdId, sessionId, JSON.stringify(seatIds), expiresAt, createdAt]
      );
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 3}`).join(', ');
      const updated = await db.query(
        `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
         WHERE id IN (${updatePlaceholders}) AND status = 'available'
         RETURNING id`,
        [holdId, expiresAt, ...seatIds]
      );
      if (updated.rows.length !== seatIds.length) {
        throw new Error('Atomic hold invariant failed; no seats were committed');
      }
      return {
        ok: true,
        released,
        hold: { id: holdId, sessionId, seatIds, expiresAt, ttlSeconds: HOLD_TTL_SECONDS, status: 'active' },
      };
    }));

    if (result.released?.length) {
      broadcast('seats', { type: 'released', seats: result.released.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })) });
    }
    if (!result.ok) return res.status(result.status).json(result.body);

    broadcast('seats', {
      type: 'held',
      hold: result.hold,
      seats: result.hold.seatIds.map((id) => ({ id, status: 'held', holdId: result.hold.id, holdExpiresAt: result.hold.expiresAt })),
    });
    res.status(201).json({ hold: result.hold, inventory: await inventory() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    const result = await withDbLock(async () => tx(async () => {
      const released = await expireHoldsInternal();
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) {
        return { ok: false, status: 404, released, body: { error: 'Unknown hold' } };
      }
      const hold = holdResult.rows[0];
      const seatIds = JSON.parse(hold.seat_ids);
      if (hold.status === 'confirmed') {
        return {
          ok: true,
          released,
          alreadyConfirmed: true,
          booking: { id: hold.booking_id, holdId: hold.id, sessionId: hold.session_id, seatIds, confirmedAt: hold.confirmed_at },
        };
      }
      if (hold.status !== 'active') {
        return { ok: false, status: 409, released, body: { error: `Hold is ${hold.status}` } };
      }
      if (sessionId && sessionId !== hold.session_id) {
        return { ok: false, status: 403, released, body: { error: 'Hold belongs to a different session' } };
      }
      if (hold.expires_at <= nowIso()) {
        await expireHoldsInternal();
        return { ok: false, status: 409, released, body: { error: 'Hold has expired' } };
      }
      const seats = await db.query('SELECT id FROM seats WHERE hold_id = $1 AND status = $2', [hold.id, 'held']);
      if (seats.rows.length !== seatIds.length) {
        return { ok: false, status: 409, released, body: { error: 'Hold no longer owns all seats' } };
      }
      const bookingId = hold.booking_id || randomUUID();
      const confirmedAt = nowIso();
      await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $2, hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [hold.id, hold.session_id]
      );
      await db.query(
        `UPDATE holds SET status = 'confirmed', booking_id = $2, confirmed_at = $3 WHERE id = $1`,
        [hold.id, bookingId, confirmedAt]
      );
      return { ok: true, released, booking: { id: bookingId, holdId: hold.id, sessionId: hold.session_id, seatIds, confirmedAt } };
    }));

    if (result.released?.length) {
      broadcast('seats', { type: 'released', seats: result.released.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })) });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    if (!result.alreadyConfirmed) {
      broadcast('seats', {
        type: 'booked',
        booking: result.booking,
        seats: result.booking.seatIds.map((id) => ({ id, status: 'booked', holdId: null, holdExpiresAt: null, bookedBy: result.booking.sessionId })),
      });
    }
    res.json({ booking: result.booking, idempotent: Boolean(result.alreadyConfirmed), inventory: await inventory() });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    const result = await withDbLock(async () => tx(async () => {
      const releasedByExpiry = await expireHoldsInternal();
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) return { ok: false, status: 404, releasedByExpiry, body: { error: 'Unknown hold' } };
      const hold = holdResult.rows[0];
      if (sessionId && sessionId !== hold.session_id) return { ok: false, status: 403, releasedByExpiry, body: { error: 'Hold belongs to a different session' } };
      if (hold.status !== 'active') {
        return { ok: true, releasedByExpiry, released: [], hold: { id: hold.id, status: hold.status } };
      }
      const updated = await db.query(
        `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id`,
        [hold.id]
      );
      await db.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [hold.id]);
      return { ok: true, releasedByExpiry, released: updated.rows.map((r) => r.id), hold: { id: hold.id, status: 'released' } };
    }));

    const allReleased = [...(result.releasedByExpiry || []), ...(result.released || [])];
    if (allReleased.length) {
      broadcast('seats', { type: 'released', seats: allReleased.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null })) });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json({ hold: result.hold, releasedSeatIds: result.released, inventory: await inventory() });
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
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err) });
});

await initDb();
setInterval(() => {
  sweepExpiredAndBroadcast().catch((err) => console.error('expiry sweep failed', err));
}, 1000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DB_PATH}`);
});
