import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const CLIENT_DIR = path.join(__dirname, '..', 'dist');
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 1000);

const app = express();
const db = new PGlite(DB_DIR);
const clients = new Set();

// PGlite runs in-process. This queue serialises multi-statement transactional
// units so Express cannot interleave BEGIN/COMMIT sections on the same handle.
let txQueue = Promise.resolve();
function withTransaction(fn) {
  const run = txQueue.then(async () => {
    await db.query('BEGIN');
    try {
      const value = await fn();
      await db.query('COMMIT');
      return value;
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {
        // Ignore rollback failures; preserve original error.
      }
      throw err;
    }
  });
  txQueue = run.catch(() => {});
  return run;
}

function sendError(res, status, message, extra = {}) {
  res.status(status).json({ error: message, ...extra });
}

function normaliseSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) return null;
  const ids = [...new Set(seatIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  return ids.length === seatIds.length ? ids : null;
}

function publicSeat(row) {
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

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch (_) {
      clients.delete(res);
    }
  }
}

async function broadcastSeats(seatIds, event = 'seats') {
  if (!seatIds?.length) return;
  const { rows } = await db.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      WHERE id = ANY($1::int[])
      ORDER BY id`,
    [seatIds],
  );
  broadcast(event, { seats: rows.map(publicSeat), seatIds });
}

async function releaseExpiredHoldsInCurrentTx() {
  const expired = await db.query(
    `SELECT id, hold_id
       FROM seats
      WHERE status = 'held'
        AND hold_expires_at <= NOW()`,
  );
  if (!expired.rows.length) return [];

  const seatIds = expired.rows.map((row) => row.id);
  const holdIds = [...new Set(expired.rows.map((row) => row.hold_id).filter(Boolean))];
  const { rows } = await db.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE id = ANY($1::int[])
      RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
    [seatIds],
  );
  if (holdIds.length) {
    await db.query("UPDATE holds SET status = 'expired' WHERE id = ANY($1::text[]) AND status = 'active'", [holdIds]);
  }
  return rows;
}

async function sweepExpiredHolds() {
  try {
    const released = await withTransaction(() => releaseExpiredHoldsInCurrentTx());
    if (released.length) {
      broadcast('seats', { seats: released.map(publicSeat), seatIds: released.map((s) => s.id), reason: 'expired' });
    }
  } catch (err) {
    console.error('expiry sweep failed:', err);
  }
}

async function initialiseDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')) DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      booked_at TIMESTAMPTZ,
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL) OR
        (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL) OR
        (status = 'booked' AND hold_id IS NOT NULL AND booked_by IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids INTEGER[] NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')) DEFAULT 'active',
      booking_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status_expiry ON seats(status, hold_expires_at);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    for (const rowLabel of ROWS) {
      for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
        await db.query('INSERT INTO seats (row_label, seat_number) VALUES ($1, $2)', [rowLabel, seatNumber]);
      }
    }
  }
}

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, ttlSeconds: HOLD_TTL_SECONDS })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const released = await withTransaction(() => releaseExpiredHoldsInCurrentTx());
    if (released.length) {
      broadcast('seats', { seats: released.map(publicSeat), seatIds: released.map((s) => s.id), reason: 'expired' });
    }
    const { rows } = await db.query(
      `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
        ORDER BY row_label, seat_number`,
    );
    const totals = rows.reduce((acc, row) => {
      acc[row.status] += 1;
      return acc;
    }, { available: 0, held: 0, booked: 0 });
    res.json({ seats: rows.map(publicSeat), totals, ttlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normaliseSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!seatIds) return sendError(res, 400, 'seatIds must be a non-empty array of positive integers with no duplicates');
    if (!sessionId) return sendError(res, 400, 'sessionId is required');

    const result = await withTransaction(async () => {
      await releaseExpiredHoldsInCurrentTx();

      const existing = await db.query(
        `SELECT id, status
           FROM seats
          WHERE id = ANY($1::int[])
          ORDER BY id`,
        [seatIds],
      );
      const foundIds = new Set(existing.rows.map((r) => r.id));
      const conflicts = existing.rows.filter((r) => r.status !== 'available').map((r) => r.id);
      for (const id of seatIds) if (!foundIds.has(id)) conflicts.push(id);
      if (existing.rows.length !== seatIds.length || conflicts.length) {
        return { ok: false, conflicts: [...new Set(conflicts)].sort((a, b) => a - b) };
      }

      const holdId = randomUUID();
      const expires = await db.query(`SELECT NOW() + ($1::int * INTERVAL '1 second') AS expires_at`, [HOLD_TTL_SECONDS]);
      const expiresAt = expires.rows[0].expires_at;

      const updated = await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2
          WHERE id = ANY($3::int[])
            AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId, expiresAt, seatIds],
      );
      if (updated.rows.length !== seatIds.length) {
        return { ok: false, conflicts: seatIds };
      }

      await db.query(
        `INSERT INTO holds (id, session_id, seat_ids, expires_at)
         VALUES ($1, $2, $3::int[], $4)`,
        [holdId, sessionId, seatIds, expiresAt],
      );

      return { ok: true, hold: { id: holdId, sessionId, seatIds, expiresAt, ttlSeconds: HOLD_TTL_SECONDS }, seats: updated.rows };
    });

    if (!result.ok) return sendError(res, 409, 'One or more seats are unavailable', { conflictSeatIds: result.conflicts });
    broadcast('seats', { seats: result.seats.map(publicSeat), seatIds: result.seats.map((s) => s.id), reason: 'held' });
    res.status(201).json({ hold: result.hold, seats: result.seats.map(publicSeat) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) return sendError(res, 400, 'sessionId is required');

    const result = await withTransaction(async () => {
      await releaseExpiredHoldsInCurrentTx();

      const holdRes = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (!holdRes.rows.length) return { ok: false, status: 404, message: 'Unknown hold' };
      const hold = holdRes.rows[0];
      if (hold.session_id !== sessionId) return { ok: false, status: 403, message: 'Hold belongs to a different session' };

      if (hold.status === 'confirmed') {
        const seats = await db.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats
            WHERE hold_id = $1 AND status = 'booked'
            ORDER BY id`,
          [holdId],
        );
        return { ok: true, idempotent: true, bookingId: hold.booking_id, seats: seats.rows };
      }
      if (hold.status !== 'active') return { ok: false, status: 409, message: `Hold is ${hold.status}` };

      const activeSeats = await db.query(
        `SELECT id
           FROM seats
          WHERE id = ANY($1::int[])
            AND hold_id = $2
            AND status = 'held'
            AND hold_expires_at > NOW()`,
        [hold.seat_ids, holdId],
      );
      if (activeSeats.rows.length !== hold.seat_ids.length) {
        await db.query("UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'", [holdId]);
        return { ok: false, status: 409, message: 'Hold has expired or no longer owns all seats' };
      }

      const bookingId = randomUUID();
      const booked = await db.query(
        `UPDATE seats
            SET status = 'booked', booked_by = $1, booked_at = NOW(), hold_expires_at = NULL
          WHERE id = ANY($2::int[])
            AND hold_id = $3
            AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [sessionId, hold.seat_ids, holdId],
      );
      if (booked.rows.length !== hold.seat_ids.length) {
        throw new Error('Invariant violation while confirming hold');
      }
      await db.query(
        `UPDATE holds
            SET status = 'confirmed', booking_id = $1, confirmed_at = NOW()
          WHERE id = $2`,
        [bookingId, holdId],
      );
      return { ok: true, idempotent: false, bookingId, seats: booked.rows };
    });

    if (!result.ok) return sendError(res, result.status, result.message);
    if (!result.idempotent) {
      broadcast('seats', { seats: result.seats.map(publicSeat), seatIds: result.seats.map((s) => s.id), reason: 'booked' });
    }
    res.json({ booking: { id: result.bookingId, holdId, seatIds: result.seats.map((s) => s.id) }, seats: result.seats.map(publicSeat), idempotent: result.idempotent });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!sessionId) return sendError(res, 400, 'sessionId is required');

    const result = await withTransaction(async () => {
      await releaseExpiredHoldsInCurrentTx();
      const holdRes = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (!holdRes.rows.length) return { ok: false, status: 404, message: 'Unknown hold' };
      const hold = holdRes.rows[0];
      if (hold.session_id !== sessionId) return { ok: false, status: 403, message: 'Hold belongs to a different session' };
      if (hold.status !== 'active') return { ok: true, seats: [], already: hold.status };

      const released = await db.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId],
      );
      await db.query("UPDATE holds SET status = 'released' WHERE id = $1", [holdId]);
      return { ok: true, seats: released.rows };
    });

    if (!result.ok) return sendError(res, result.status, result.message);
    if (result.seats.length) {
      broadcast('seats', { seats: result.seats.map(publicSeat), seatIds: result.seats.map((s) => s.id), reason: 'released' });
    }
    res.json({ released: result.seats.map(publicSeat), already: result.already || null });
  } catch (err) {
    next(err);
  }
});

app.use(express.static(CLIENT_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await initialiseDatabase();
setInterval(sweepExpiredHolds, SWEEP_INTERVAL_MS).unref();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DB_DIR}`);
});
