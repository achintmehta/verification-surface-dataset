import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const db = new PGlite(path.join(__dirname, '..', 'pglite-data'));
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

let lockTail = Promise.resolve();
function withDbLock(work) {
  const run = lockTail.then(work, work);
  lockTail = run.catch(() => {});
  return run;
}

async function inTransaction(work) {
  await db.query('BEGIN');
  try {
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors; surface the original failure.
    }
    throw error;
  }
}

function placeholders(start, count) {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}

function seatParams(seatIds, start = 1) {
  return placeholders(start, seatIds.length);
}

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) return null;
  const ids = [...new Set(input.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > ROWS.length * SEATS_PER_ROW) return null;
  return ids;
}

function makeApiError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function serializeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  };
}

function summarizeInventory(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.total += 1;
      acc[row.status] += 1;
      return acc;
    },
    { total: 0, available: 0, held: 0, booked: 0 }
  );
}

const clients = new Set();
function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(message);
    } catch (_) {
      clients.delete(client);
    }
  }
}

function broadcastSeatChanges(changes, reason) {
  if (changes && changes.length > 0) {
    broadcast('seats', { reason, changes });
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
      UNIQUE (row_label, seat_number)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ NULL,
      released_at TIMESTAMPTZ NULL,
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

  await db.query(`CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_holds_expiry ON holds(status, expires_at)`);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(rows[0].count) === 0) {
    await inTransaction(async () => {
      for (const rowLabel of ROWS) {
        for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
          const id = `${rowLabel}-${seatNumber}`;
          await db.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [id, rowLabel, seatNumber, 'available']
          );
        }
      }
    });
  }
}

async function expireStaleHolds(tx, nowIso = new Date().toISOString()) {
  const expired = await tx.query(
    `SELECT h.id
       FROM holds h
      WHERE h.status = 'active'
        AND h.expires_at <= $1`,
    [nowIso]
  );

  const holdIds = expired.rows.map((row) => row.id);
  if (holdIds.length === 0) return [];

  const released = await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE status = 'held'
        AND hold_id IN (${placeholders(1, holdIds.length)})
      RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
    holdIds
  );

  await tx.query(
    `UPDATE holds
        SET status = 'expired', released_at = $1
      WHERE status = 'active'
        AND id IN (${placeholders(2, holdIds.length)})`,
    [nowIso, ...holdIds]
  );

  return released.rows.map(serializeSeat);
}

async function sweepExpiredAndBroadcast() {
  const changes = await withDbLock(() =>
    inTransaction(async (tx) => expireStaleHolds(tx))
  );
  broadcastSeatChanges(changes, 'expired');
  return changes;
}

async function getAllSeats(tx) {
  const result = await tx.query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      ORDER BY row_label, seat_number`
  );
  return result.rows.map(serializeSeat);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const result = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiredChanges = await expireStaleHolds(tx);
        const seats = await getAllSeats(tx);
        return { seats, expiredChanges };
      })
    );
    broadcastSeatChanges(result.expiredChanges, 'expired');
    res.json({ seats: result.seats, inventory: summarizeInventory(result.seats), holdTtlMs: HOLD_TTL_MS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!seatIds || !sessionId) {
      throw makeApiError(400, 'bad_request', 'seatIds must be a non-empty array and sessionId is required');
    }

    const outcome = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiredChanges = await expireStaleHolds(tx);
        const existing = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats
            WHERE id IN (${seatParams(seatIds)})`,
          seatIds
        );

        const foundIds = new Set(existing.rows.map((row) => row.id));
        const missingIds = seatIds.filter((id) => !foundIds.has(id));
        if (missingIds.length > 0) {
          throw makeApiError(400, 'unknown_seats', 'One or more requested seats do not exist', {
            expiredChanges,
            seatIds: missingIds
          });
        }

        const conflicts = existing.rows.filter((row) => row.status !== 'available').map(serializeSeat);
        if (conflicts.length > 0) {
          throw makeApiError(409, 'seats_unavailable', 'One or more requested seats are unavailable', {
            expiredChanges,
            conflicts
          });
        }

        const holdId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
        await tx.query(
          `INSERT INTO holds (id, session_id, status, expires_at)
           VALUES ($1, $2, 'active', $3)`,
          [holdId, sessionId, expiresAt]
        );

        for (const seatId of seatIds) {
          await tx.query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)', [holdId, seatId]);
        }

        const updated = await tx.query(
          `UPDATE seats
              SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
            WHERE status = 'available'
              AND id IN (${placeholders(3, seatIds.length)})
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId, expiresAt, ...seatIds]
        );

        if (updated.rows.length !== seatIds.length) {
          throw makeApiError(409, 'seats_unavailable', 'One or more requested seats became unavailable', {
            expiredChanges,
            conflicts: updated.rows.map(serializeSeat)
          });
        }

        const heldSeats = updated.rows.map(serializeSeat);
        return {
          expiredChanges,
          heldSeats,
          hold: { id: holdId, sessionId, seatIds, expiresAt, ttlMs: HOLD_TTL_MS, status: 'active' }
        };
      })
    );

    broadcastSeatChanges(outcome.expiredChanges, 'expired');
    broadcastSeatChanges(outcome.heldSeats, 'held');
    res.status(201).json({ hold: outcome.hold, seats: outcome.heldSeats });
  } catch (error) {
    broadcastSeatChanges(error.expiredChanges, 'expired');
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId || !sessionId) throw makeApiError(400, 'bad_request', 'holdId and sessionId are required');

    const outcome = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiredChanges = await expireStaleHolds(tx);
        const holdRes = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (holdRes.rows.length === 0) {
          throw makeApiError(404, 'unknown_hold', 'Unknown hold', { expiredChanges });
        }
        const hold = holdRes.rows[0];
        if (hold.session_id !== sessionId) {
          throw makeApiError(403, 'not_hold_owner', 'This session does not own the hold', { expiredChanges });
        }

        const seatRes = await tx.query(
          `SELECT s.id, s.row_label, s.seat_number, s.status, s.hold_id, s.hold_expires_at, s.booked_by
             FROM hold_seats hs
             JOIN seats s ON s.id = hs.seat_id
            WHERE hs.hold_id = $1
            ORDER BY s.row_label, s.seat_number`,
          [holdId]
        );

        if (hold.status === 'confirmed') {
          return {
            expiredChanges,
            bookedSeats: [],
            booking: {
              id: hold.booking_id,
              holdId,
              sessionId,
              seatIds: seatRes.rows.map((row) => row.id),
              status: 'confirmed',
              idempotent: true
            },
            seats: seatRes.rows.map(serializeSeat)
          };
        }

        if (hold.status === 'expired') {
          throw makeApiError(410, 'hold_expired', 'Hold has expired', { expiredChanges });
        }
        if (hold.status === 'released') {
          throw makeApiError(409, 'hold_released', 'Hold has been released', { expiredChanges });
        }

        const nowIso = new Date().toISOString();
        if (new Date(hold.expires_at).getTime() <= new Date(nowIso).getTime()) {
          throw makeApiError(410, 'hold_expired', 'Hold has expired', { expiredChanges });
        }

        const invalidSeats = seatRes.rows.filter((row) => row.status !== 'held' || row.hold_id !== holdId);
        if (invalidSeats.length > 0 || seatRes.rows.length === 0) {
          throw makeApiError(409, 'hold_invalid', 'Hold no longer owns all associated seats', {
            expiredChanges,
            conflicts: invalidSeats.map(serializeSeat)
          });
        }

        const bookingId = crypto.randomUUID();
        const booked = await tx.query(
          `UPDATE seats
              SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $2
            WHERE status = 'held'
              AND hold_id = $1
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`, 
          [holdId, sessionId]
        );

        if (booked.rows.length !== seatRes.rows.length) {
          throw makeApiError(409, 'hold_invalid', 'Hold could not be confirmed atomically', { expiredChanges });
        }

        await tx.query(
          `UPDATE holds
              SET status = 'confirmed', confirmed_at = $2, booking_id = $3
            WHERE id = $1`,
          [holdId, nowIso, bookingId]
        );

        const bookedSeats = booked.rows.map(serializeSeat);
        return {
          expiredChanges,
          bookedSeats,
          booking: {
            id: bookingId,
            holdId,
            sessionId,
            seatIds: bookedSeats.map((seat) => seat.id),
            status: 'confirmed',
            idempotent: false
          },
          seats: bookedSeats
        };
      })
    );

    broadcastSeatChanges(outcome.expiredChanges, 'expired');
    broadcastSeatChanges(outcome.bookedSeats, 'booked');
    res.json({ booking: outcome.booking, seats: outcome.seats });
  } catch (error) {
    broadcastSeatChanges(error.expiredChanges, 'expired');
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!holdId) throw makeApiError(400, 'bad_request', 'holdId is required');

    const outcome = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiredChanges = await expireStaleHolds(tx);
        const holdRes = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (holdRes.rows.length === 0) throw makeApiError(404, 'unknown_hold', 'Unknown hold', { expiredChanges });
        const hold = holdRes.rows[0];
        if (sessionId && hold.session_id !== sessionId) {
          throw makeApiError(403, 'not_hold_owner', 'This session does not own the hold', { expiredChanges });
        }
        if (hold.status === 'confirmed') {
          throw makeApiError(409, 'already_confirmed', 'Confirmed holds cannot be released', { expiredChanges });
        }
        if (hold.status !== 'active') {
          return { expiredChanges, releasedSeats: [], hold: { id: holdId, status: hold.status } };
        }

        const nowIso = new Date().toISOString();
        const released = await tx.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE status = 'held'
              AND hold_id = $1
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId]
        );
        await tx.query(`UPDATE holds SET status = 'released', released_at = $2 WHERE id = $1`, [holdId, nowIso]);
        return {
          expiredChanges,
          releasedSeats: released.rows.map(serializeSeat),
          hold: { id: holdId, status: 'released' }
        };
      })
    );

    broadcastSeatChanges(outcome.expiredChanges, 'expired');
    broadcastSeatChanges(outcome.releasedSeats, 'released');
    res.json({ hold: outcome.hold, seats: outcome.releasedSeats });
  } catch (error) {
    broadcastSeatChanges(error.expiredChanges, 'expired');
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

const staticDir = path.join(__dirname, '..', 'dist');
app.use(express.static(staticDir));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(staticDir, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      message: status === 500 ? 'Internal server error' : err.message,
      conflicts: err.conflicts,
      seatIds: err.seatIds
    }
  });
  if (status === 500) console.error(err);
});

await initDb();
setInterval(() => {
  sweepExpiredAndBroadcast().catch((error) => console.error('expiry sweep failed', error));
}, 5000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
