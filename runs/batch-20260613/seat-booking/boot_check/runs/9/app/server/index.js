import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 2_000);

const db = new PGlite(path.join(rootDir, 'pglite-data'));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));

const clients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null,
    bookedBy: row.booked_by
  };
}

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
      hold_session_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      booked_hold_id TEXT,
      booked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query('CREATE INDEX IF NOT EXISTS seats_status_idx ON seats(status);');
  await db.query('CREATE INDEX IF NOT EXISTS seats_hold_id_idx ON seats(hold_id);');
  await db.query('CREATE INDEX IF NOT EXISTS seats_booked_hold_id_idx ON seats(booked_hold_id);');

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let seat = 1; seat <= SEATS_PER_ROW; seat++) {
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4);',
          [`${row}${seat}`, row, seat, 'available']
        );
      }
    }
  }
}

async function releaseExpiredHoldsInternal({ shouldBroadcast = true } = {}) {
  const expired = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by
    FROM seats
    WHERE status = 'held' AND hold_expires_at <= NOW()
    ORDER BY row_label, seat_number;
  `);
  if (expired.rows.length === 0) return [];

  await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_session_id = NULL,
        hold_expires_at = NULL,
        updated_at = NOW()
    WHERE status = 'held' AND hold_expires_at <= NOW();
  `);

  const released = expired.rows.map((seat) => ({
    id: seat.id,
    rowLabel: seat.row_label,
    seatNumber: Number(seat.seat_number),
    status: 'available',
    previousStatus: 'held',
    holdId: seat.hold_id
  }));
  if (shouldBroadcast) {
    broadcast('seats', { type: 'released', seats: released });
  }
  return released;
}

async function releaseExpiredHolds(options) {
  return enqueueWrite(() => releaseExpiredHoldsInternal(options));
}

async function getSeats() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number;
  `);
  return result.rows.map(normalizeSeat);
}

async function getInventory() {
  await releaseExpiredHolds();
  const result = await db.query(`
    SELECT status, COUNT(*)::int AS count
    FROM seats
    GROUP BY status;
  `);
  const inventory = { available: 0, held: 0, booked: 0, total: 0 };
  for (const row of result.rows) {
    inventory[row.status] = Number(row.count);
    inventory.total += Number(row.count);
  }
  return inventory;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const [seats, inventory] = await Promise.all([getSeats(), getInventory()]);
    res.json({ seats, inventory, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = Array.isArray(req.body?.seatIds)
      ? [...new Set(req.body.seatIds.map(String).map((s) => s.trim()).filter(Boolean))]
      : [];
    const sessionId = String(req.body?.sessionId || '').trim();

    if (seatIds.length === 0 || !sessionId) {
      return res.status(400).json({ error: 'seatIds (non-empty array) and sessionId are required' });
    }

    const result = await enqueueWrite(async () => {
      await releaseExpiredHoldsInternal();
      await db.query('BEGIN;');
      try {
        const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
        const found = await db.query(
          `SELECT id, status, hold_id, hold_expires_at, booked_by FROM seats WHERE id IN (${placeholders}) FOR UPDATE;`,
          seatIds
        );
        const foundIds = new Set(found.rows.map((r) => r.id));
        const conflicts = [];
        for (const id of seatIds) {
          const row = found.rows.find((r) => r.id === id);
          if (!foundIds.has(id)) conflicts.push({ id, reason: 'not_found' });
          else if (row.status !== 'available') conflicts.push({ id, status: row.status, holdId: row.hold_id });
        }
        if (conflicts.length > 0 || found.rows.length !== seatIds.length) {
          await db.query('ROLLBACK;');
          return { ok: false, conflicts };
        }

        const holdId = randomUUID();
        const expiresAt = new Date(Date.now() + HOLD_TTL_MS);
        await db.query(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_session_id = $2, hold_expires_at = $3, updated_at = NOW()
           WHERE id IN (${placeholders.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 3}`)}) AND status = 'available';`,
          [holdId, sessionId, expiresAt.toISOString(), ...seatIds]
        );
        const seats = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number;`,
          [holdId]
        );
        if (seats.rows.length !== seatIds.length) {
          await db.query('ROLLBACK;');
          return { ok: false, conflicts: seatIds.map((id) => ({ id, reason: 'race_lost' })) };
        }
        await db.query('COMMIT;');
        return {
          ok: true,
          hold: { id: holdId, sessionId, expiresAt: expiresAt.toISOString(), ttlMs: HOLD_TTL_MS, seats: seats.rows.map(normalizeSeat) }
        };
      } catch (error) {
        await db.query('ROLLBACK;').catch(() => {});
        throw error;
      }
    });

    if (!result.ok) {
      return res.status(409).json({ error: 'One or more seats are unavailable', conflicts: result.conflicts });
    }
    broadcast('seats', { type: 'held', holdId: result.hold.id, seats: result.hold.seats });
    return res.status(201).json(result.hold);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId || !sessionId) return res.status(400).json({ error: 'holdId and sessionId are required' });

    const result = await enqueueWrite(async () => {
      await releaseExpiredHoldsInternal();
      await db.query('BEGIN;');
      try {
        const alreadyBooked = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE booked_hold_id = $1 AND booked_by = $2
           ORDER BY row_label, seat_number;`,
          [holdId, sessionId]
        );
        if (alreadyBooked.rows.length > 0) {
          await db.query('COMMIT;');
          return { ok: true, idempotent: true, booking: { holdId, sessionId, seats: alreadyBooked.rows.map(normalizeSeat) } };
        }

        const held = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by
           FROM seats
           WHERE hold_id = $1
           FOR UPDATE;`,
          [holdId]
        );
        if (held.rows.length === 0) {
          await db.query('ROLLBACK;');
          return { ok: false, status: 404, error: 'Unknown or expired hold' };
        }
        const badOwner = held.rows.some((r) => r.hold_session_id !== sessionId);
        const expired = held.rows.some((r) => new Date(r.hold_expires_at).getTime() <= Date.now());
        const notHeld = held.rows.some((r) => r.status !== 'held');
        if (badOwner || expired || notHeld) {
          await db.query('ROLLBACK;');
          return { ok: false, status: expired ? 410 : 409, error: expired ? 'Hold has expired' : 'Hold is not valid for this session' };
        }

        await db.query(
          `UPDATE seats
           SET status = 'booked', booked_by = $2, booked_hold_id = $1, booked_at = NOW(),
               hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL, updated_at = NOW()
           WHERE hold_id = $1 AND hold_session_id = $2 AND status = 'held';`,
          [holdId, sessionId]
        );
        const booked = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
           WHERE booked_hold_id = $1 AND booked_by = $2
           ORDER BY row_label, seat_number;`,
          [holdId, sessionId]
        );
        await db.query('COMMIT;');
        return { ok: true, idempotent: false, booking: { holdId, sessionId, seats: booked.rows.map(normalizeSeat) } };
      } catch (error) {
        await db.query('ROLLBACK;').catch(() => {});
        throw error;
      }
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (!result.idempotent) broadcast('seats', { type: 'booked', holdId, seats: result.booking.seats });
    return res.json(result.booking);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!holdId) return res.status(400).json({ error: 'holdId is required' });

    const result = await enqueueWrite(async () => {
      await releaseExpiredHoldsInternal();
      await db.query('BEGIN;');
      try {
        const params = sessionId ? [holdId, sessionId] : [holdId];
        const ownerClause = sessionId ? 'AND hold_session_id = $2' : '';
        const held = await db.query(
          `SELECT id, row_label, seat_number, hold_id FROM seats WHERE hold_id = $1 ${ownerClause} AND status = 'held' FOR UPDATE;`,
          params
        );
        if (held.rows.length === 0) {
          await db.query('COMMIT;');
          return { released: [] };
        }
        await db.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL, updated_at = NOW()
           WHERE hold_id = $1 ${ownerClause} AND status = 'held';`,
          params
        );
        await db.query('COMMIT;');
        return {
          released: held.rows.map((s) => ({ id: s.id, rowLabel: s.row_label, seatNumber: Number(s.seat_number), status: 'available', previousStatus: 'held', holdId }))
        };
      } catch (error) {
        await db.query('ROLLBACK;').catch(() => {});
        throw error;
      }
    });
    if (result.released.length > 0) broadcast('seats', { type: 'released', holdId, seats: result.released });
    res.json({ holdId, released: result.released });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await getInventory());
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
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err) });
});

await initDb();
setInterval(() => releaseExpiredHolds().catch((err) => console.error('expiry sweep failed', err)), SWEEP_INTERVAL_MS).unref();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
