import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const DB_PATH = process.env.PGLITE_DATA_DIR || './.pglite-data';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const db = new PGlite(DB_PATH);
const sseClients = new Set();
let writeQueue = Promise.resolve();
let ready = false;

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function nowIsoPlus(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null,
    bookedBy: row.booked_by,
    bookingId: row.booking_id,
    bookedAt: row.booked_at ? new Date(row.booked_at).toISOString() : null,
  };
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
      hold_session_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      booking_id TEXT,
      booked_at TIMESTAMPTZ,
      UNIQUE (row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_session_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL AND booking_id IS NULL AND booked_at IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_session_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL AND booking_id IS NULL AND booked_at IS NULL)
        OR (status = 'booked' AND hold_id IS NULL AND hold_session_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NOT NULL AND booking_id IS NOT NULL AND booked_at IS NOT NULL)
      )
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_expiry ON seats(hold_expires_at);`);

  const countResult = await query('SELECT COUNT(*)::int AS count FROM seats;');
  if (Number(countResult.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let seat = 1; seat <= SEATS_PER_ROW; seat += 1) {
        const id = `${row}${seat}`;
        await query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4);',
          [id, row, seat, 'available']
        );
      }
    }
    console.log(`Seeded ${ROWS.length * SEATS_PER_ROW} seats`);
  }
  ready = true;
}

async function transaction(callback) {
  await query('BEGIN;');
  try {
    const result = await callback();
    await query('COMMIT;');
    return result;
  } catch (error) {
    try {
      await query('ROLLBACK;');
    } catch (rollbackError) {
      console.error('Rollback failed', rollbackError);
    }
    throw error;
  }
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...sseClients]) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastSeatChanges(type, seats, extra = {}) {
  if (!seats || seats.length === 0) return;
  const normalized = seats.map(normalizeSeat);
  broadcast('seats', { type, seats: normalized, ...extra });
}

async function releaseExpiredHoldsInTransaction() {
  const expired = await query(
    `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL
     WHERE status = 'held' AND hold_expires_at <= now()
     RETURNING *;`
  );
  return expired.rows;
}

async function sweepExpiredHolds({ locked = true } = {}) {
  const work = async () => transaction(async () => releaseExpiredHoldsInTransaction());
  const released = locked ? await withWriteLock(work) : await work();
  broadcastSeatChanges('released', released, { reason: 'expired' });
  return released;
}

async function getAllSeatsWithExpiry() {
  return withWriteLock(async () => {
    const released = await transaction(async () => {
      const expiredRows = await releaseExpiredHoldsInTransaction();
      return expiredRows;
    });
    broadcastSeatChanges('released', released, { reason: 'expired' });
    const result = await query('SELECT * FROM seats ORDER BY row_label, seat_number;');
    return result.rows.map(normalizeSeat);
  });
}

function validateSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { ok: false, message: 'seatIds must be a non-empty array' };
  }
  const unique = [...new Set(seatIds.map((s) => String(s).trim()).filter(Boolean))];
  if (unique.length !== seatIds.length) {
    return { ok: false, message: 'seatIds must be unique non-empty strings' };
  }
  if (unique.length > ROWS.length * SEATS_PER_ROW) {
    return { ok: false, message: 'Too many seats requested' };
  }
  return { ok: true, seatIds: unique };
}

function httpError(status, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, details);
  return error;
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, ready, ttlSeconds: HOLD_TTL_SECONDS });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getAllSeatsWithExpiry();
    const inventory = seats.reduce(
      (acc, seat) => {
        acc[seat.status] += 1;
        acc.total += 1;
        return acc;
      },
      { total: 0, available: 0, held: 0, booked: 0 }
    );
    res.json({ seats, inventory, ttlSeconds: HOLD_TTL_SECONDS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const validation = validateSeatIds(req.body?.seatIds);
    if (!validation.ok) throw httpError(400, validation.message);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) throw httpError(400, 'sessionId is required');

    const result = await withWriteLock(async () => transaction(async () => {
      const released = await releaseExpiredHoldsInTransaction();
      const seatIds = validation.seatIds;
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(', ');
      const existing = await query(`SELECT * FROM seats WHERE id IN (${placeholders}) ORDER BY row_label, seat_number;`, seatIds);
      const existingIds = new Set(existing.rows.map((row) => row.id));
      const missing = seatIds.filter((seatId) => !existingIds.has(seatId));
      const conflictingRows = existing.rows.filter((row) => row.status !== 'available');
      if (missing.length || conflictingRows.length || existing.rows.length !== seatIds.length) {
        throw httpError(409, 'One or more seats are unavailable', {
          released,
          conflicts: [
            ...missing.map((id) => ({ id, status: 'missing' })),
            ...conflictingRows.map((row) => ({ id: row.id, status: row.status, holdId: row.hold_id, bookedBy: row.booked_by })),
          ],
        });
      }

      const holdId = crypto.randomUUID();
      const expiresAt = nowIsoPlus(HOLD_TTL_SECONDS);
      const params = [holdId, sessionId, expiresAt, ...seatIds];
      const updated = await query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_session_id = $2, hold_expires_at = $3::timestamptz
          WHERE id IN (${seatIds.map((_, i) => `$${i + 4}`).join(', ')})
            AND status = 'available'
          RETURNING *;`,
        params
      );
      if (updated.rows.length !== seatIds.length) {
        throw httpError(409, 'One or more seats became unavailable', { conflicts: seatIds.map((id) => ({ id, status: 'unknown' })), released });
      }
      return {
        released,
        held: updated.rows,
        hold: {
          id: holdId,
          sessionId,
          seatIds,
          expiresAt,
          ttlSeconds: HOLD_TTL_SECONDS,
        },
      };
    }));

    broadcastSeatChanges('released', result.released, { reason: 'expired' });
    broadcastSeatChanges('held', result.held, { hold: result.hold });
    res.status(201).json({ hold: result.hold, seats: result.held.map(normalizeSeat) });
  } catch (error) {
    if (error.released) broadcastSeatChanges('released', error.released, { reason: 'expired' });
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId) throw httpError(400, 'holdId is required');
    if (!sessionId) throw httpError(400, 'sessionId is required');

    const result = await withWriteLock(async () => transaction(async () => {
      const released = await releaseExpiredHoldsInTransaction();
      const active = await query(
        `SELECT * FROM seats WHERE hold_id = $1 AND hold_session_id = $2 AND status = 'held' ORDER BY row_label, seat_number;`,
        [holdId, sessionId]
      );
      if (active.rows.length > 0) {
        const expiredSeat = active.rows.find((row) => new Date(row.hold_expires_at).getTime() <= Date.now());
        if (expiredSeat) throw httpError(409, 'Hold has expired', { released });
        const bookingId = crypto.randomUUID();
        const booked = await query(
          `UPDATE seats
              SET status = 'booked', booked_by = hold_session_id, booking_id = $2, booked_at = now(),
                  hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND hold_session_id = $3 AND status = 'held' AND hold_expires_at > now()
            RETURNING *;`,
          [holdId, bookingId, sessionId]
        );
        if (booked.rows.length !== active.rows.length) throw httpError(409, 'Hold is no longer active', { released });
        const seatIds = booked.rows.map((row) => row.id);
        await query(
          `INSERT INTO confirmations (hold_id, session_id, booking_id, seat_ids_json)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (hold_id, session_id) DO NOTHING;`,
          [holdId, sessionId, bookingId, JSON.stringify(seatIds)]
        );
        return {
          released,
          booked: booked.rows,
          booking: { id: bookingId, holdId, sessionId, seatIds },
          idempotent: false,
        };
      }

      const alreadyBooked = await query(
        `SELECT * FROM seats WHERE booking_id = $1 AND booked_by = $2 AND status = 'booked' ORDER BY row_label, seat_number;`,
        [holdId, sessionId]
      );
      if (alreadyBooked.rows.length > 0) {
        return {
          released,
          booked: [],
          bookingSeats: alreadyBooked.rows,
          booking: { id: holdId, holdId, sessionId, seatIds: alreadyBooked.rows.map((row) => row.id) },
          idempotent: true,
        };
      }

      const historical = await query(
        `SELECT * FROM confirmations WHERE hold_id = $1 AND session_id = $2;`,
        [holdId, sessionId]
      );
      if (historical.rows.length > 0) {
        const seatIds = JSON.parse(historical.rows[0].seat_ids_json);
        const seats = await query(`SELECT * FROM seats WHERE id IN (${seatIds.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY row_label, seat_number;`, seatIds);
        return {
          released,
          booked: [],
          bookingSeats: seats.rows,
          booking: { id: historical.rows[0].booking_id, holdId, sessionId, seatIds },
          idempotent: true,
        };
      }

      throw httpError(404, 'Unknown, expired, or already released hold', { released });
    }));

    broadcastSeatChanges('released', result.released, { reason: 'expired' });
    broadcastSeatChanges('booked', result.booked, { booking: result.booking });
    const responseSeats = (result.idempotent ? result.bookingSeats : result.booked).map(normalizeSeat);
    res.json({ booking: result.booking, seats: responseSeats, idempotent: result.idempotent });
  } catch (error) {
    if (error.released) broadcastSeatChanges('released', error.released, { reason: 'expired' });
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!holdId) throw httpError(400, 'holdId is required');
    if (!sessionId) throw httpError(400, 'sessionId is required');

    const result = await withWriteLock(async () => transaction(async () => {
      const expired = await releaseExpiredHoldsInTransaction();
      const released = await query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1 AND hold_session_id = $2 AND status = 'held'
          RETURNING *;`,
        [holdId, sessionId]
      );
      return { expired, released: released.rows };
    }));

    broadcastSeatChanges('released', result.expired, { reason: 'expired' });
    broadcastSeatChanges('released', result.released, { reason: 'released' });
    res.json({ releasedSeatIds: result.released.map((row) => row.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, ttlSeconds: HOLD_TTL_SECONDS })}\n\n`);
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
    conflicts: err.conflicts,
  });
});

await initDb();
await query(
  `CREATE TABLE IF NOT EXISTS confirmations (
    hold_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    seat_ids_json TEXT NOT NULL,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hold_id, session_id)
  );`
);

setInterval(() => {
  sweepExpiredHolds().catch((error) => console.error('Expiry sweep failed', error));
}, 2000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
