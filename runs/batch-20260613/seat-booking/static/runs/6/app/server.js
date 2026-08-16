import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);
const db = new PGlite(process.env.PGLITE_DATA_DIR || './pglite-data');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

let txChain = Promise.resolve();
const clients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function placeholders(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(',');
}

function normalizeSeatIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? ids : null;
}

function publicSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.status === 'held' ? row.hold_id : null,
    holdExpiresAt: row.status === 'held' ? row.hold_expires_at : null,
    bookedBy: row.status === 'booked' ? row.booked_by : null,
  };
}

async function withLock(fn) {
  const previous = txChain;
  let release;
  txChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function inTransaction(fn) {
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
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(message);
  }
}

function broadcastSeats(seats, reason) {
  if (!seats.length) return;
  broadcast('seats', { reason, seats: seats.map(publicSeat), at: nowIso() });
}

async function selectSeatsByIds(ids) {
  if (!ids.length) return [];
  const sql = `SELECT * FROM seats WHERE id IN (${placeholders(ids)}) ORDER BY id`;
  const result = await db.query(sql, ids);
  return result.rows;
}

async function sweepExpiredHoldsInternal() {
  const expired = await db.query(
    `SELECT id FROM holds
     WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP`
  );
  const holdIds = expired.rows.map((row) => row.id);
  if (!holdIds.length) return [];

  const released = await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_id IN (${placeholders(holdIds)})
      RETURNING *`,
    holdIds
  );

  await db.query(
    `UPDATE holds
        SET status = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders(holdIds)})`,
    holdIds
  );

  broadcastSeats(released.rows, 'expired');
  return released.rows;
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL)
      )
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      booking_id TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_holds_expiry ON holds(status, expires_at)`);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    await inTransaction(async () => {
      let id = 1;
      for (const row of ROWS) {
        for (let seat = 1; seat <= SEATS_PER_ROW; seat += 1) {
          await db.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')`,
            [id, row, seat]
          );
          id += 1;
        }
      }
    });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  res.write(`event: hello\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    await withLock(() => inTransaction(sweepExpiredHoldsInternal));
    const result = await db.query('SELECT * FROM seats ORDER BY row_label, seat_number');
    const totals = result.rows.reduce(
      (acc, seat) => {
        acc[seat.status] += 1;
        acc.total += 1;
        return acc;
      },
      { available: 0, held: 0, booked: 0, total: 0 }
    );
    res.json({ seats: result.rows.map(publicSeat), totals, serverTime: nowIso(), holdTtlMs: HOLD_TTL_MS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  const seatIds = normalizeSeatIds(req.body?.seatIds);
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!seatIds || !sessionId) {
    res.status(400).json({ error: 'seatIds (non-empty unique positive integer array) and sessionId are required' });
    return;
  }

  try {
    const result = await withLock(() =>
      inTransaction(async () => {
        await sweepExpiredHoldsInternal();
        const seats = await selectSeatsByIds(seatIds);
        const found = new Set(seats.map((seat) => seat.id));
        const conflicts = [
          ...seatIds.filter((id) => !found.has(id)),
          ...seats.filter((seat) => seat.status !== 'available').map((seat) => seat.id),
        ].sort((a, b) => a - b);

        if (seats.length !== seatIds.length || conflicts.length) {
          return { conflict: true, conflicts };
        }

        const holdId = crypto.randomUUID();
        const expiresAt = futureIso(HOLD_TTL_MS);
        await db.query(
          `INSERT INTO holds (id, session_id, status, expires_at)
           VALUES ($1, $2, 'active', $3)`,
          [holdId, sessionId, expiresAt]
        );

        const updated = await db.query(
          `UPDATE seats
              SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
            WHERE id IN (${placeholders(seatIds, 3)}) AND status = 'available'
            RETURNING *`,
          [holdId, expiresAt, ...seatIds]
        );

        if (updated.rows.length !== seatIds.length) {
          throw new Error('Atomic hold acquisition failed; please retry');
        }

        broadcastSeats(updated.rows, 'held');
        return { conflict: false, hold: { id: holdId, sessionId, seatIds, expiresAt }, seats: updated.rows };
      })
    );

    if (result.conflict) {
      res.status(409).json({ error: 'One or more seats are unavailable', conflictingSeatIds: result.conflicts });
      return;
    }
    res.status(201).json({ hold: result.hold, seats: result.seats.map(publicSeat), serverTime: nowIso() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  const holdId = req.params.holdId;
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  try {
    const result = await withLock(() =>
      inTransaction(async () => {
        await sweepExpiredHoldsInternal();
        const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        const hold = holdResult.rows[0];
        if (!hold || hold.session_id !== sessionId) {
          return { errorStatus: 404, error: 'Unknown hold' };
        }

        if (hold.status === 'confirmed') {
          const seats = await db.query('SELECT * FROM seats WHERE hold_id = $1 AND status = \'booked\' ORDER BY id', [holdId]);
          return {
            confirmed: true,
            idempotent: true,
            booking: { id: hold.booking_id, holdId, sessionId, seatIds: seats.rows.map((seat) => seat.id), confirmedAt: hold.confirmed_at },
            seats: seats.rows,
          };
        }

        if (hold.status !== 'active') {
          return { errorStatus: 409, error: `Hold is ${hold.status}` };
        }

        const heldSeats = await db.query('SELECT * FROM seats WHERE hold_id = $1 AND status = \'held\' ORDER BY id', [holdId]);
        if (!heldSeats.rows.length) {
          return { errorStatus: 409, error: 'Hold has no active seats' };
        }

        const bookingId = crypto.randomUUID();
        const booked = await db.query(
          `UPDATE seats
              SET status = 'booked', booked_by = $1, hold_expires_at = NULL
            WHERE hold_id = $2 AND status = 'held'
            RETURNING *`,
          [sessionId, holdId]
        );

        await db.query(
          `UPDATE holds
              SET status = 'confirmed', booking_id = $1, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2`,
          [bookingId, holdId]
        );

        broadcastSeats(booked.rows, 'booked');
        return {
          confirmed: true,
          idempotent: false,
          booking: { id: bookingId, holdId, sessionId, seatIds: booked.rows.map((seat) => seat.id), confirmedAt: nowIso() },
          seats: booked.rows,
        };
      })
    );

    if (result.error) {
      res.status(result.errorStatus).json({ error: result.error });
      return;
    }
    res.json({ booking: result.booking, seats: result.seats.map(publicSeat), idempotent: result.idempotent });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  const holdId = req.params.holdId;
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  try {
    const result = await withLock(() =>
      inTransaction(async () => {
        await sweepExpiredHoldsInternal();
        const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        const hold = holdResult.rows[0];
        if (!hold || hold.session_id !== sessionId) return { errorStatus: 404, error: 'Unknown hold' };
        if (hold.status !== 'active') return { released: false, status: hold.status, seats: [] };

        const released = await db.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING *`,
          [holdId]
        );
        await db.query(
          `UPDATE holds SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [holdId]
        );
        broadcastSeats(released.rows, 'released');
        return { released: true, status: 'released', seats: released.rows };
      })
    );

    if (result.error) {
      res.status(result.errorStatus).json({ error: result.error });
      return;
    }
    res.json({ released: result.released, status: result.status, seats: result.seats.map(publicSeat) });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(err.message || err) });
});

await initDb();
setInterval(() => {
  withLock(() => inTransaction(sweepExpiredHoldsInternal)).catch((error) => console.error('expiry sweep failed', error));
}, Math.max(1000, Math.min(HOLD_TTL_MS / 2, 5000)));

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
