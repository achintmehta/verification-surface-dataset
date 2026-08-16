import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 30);
const DATABASE_DIR = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'data', 'pglite');

const db = new PGlite(DATABASE_DIR);
const app = express();
const sseClients = new Set();

app.use(cors());
app.use(express.json({ limit: '64kb' }));

class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class TransactionConflict extends Error {
  constructor(conflictSeatIds = []) {
    super('One or more seats are unavailable');
    this.conflictSeatIds = conflictSeatIds;
  }
}

function sqlPlaceholders(values, offset = 1) {
  return values.map((_, index) => `$${index + offset}`).join(', ');
}

function normalizeSeatIds(seatIds) {
  if (!Array.isArray(seatIds)) return [];
  const unique = [];
  const seen = new Set();
  for (const raw of seatIds) {
    const id = String(raw || '').trim().toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function parseSeatIds(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function mapSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id || null,
    holdExpiresAt: toIso(row.hold_expires_at),
    bookedBy: row.booked_by || null,
  };
}

function mapHold(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    seatIds: parseSeatIds(row.seat_ids),
    status: row.status,
    expiresAt: toIso(row.expires_at),
    confirmedAt: toIso(row.confirmed_at),
    bookingId: row.booking_id || null,
  };
}

let transactionQueue = Promise.resolve();

async function inTransaction(callback) {
  const run = async () => {
    if (typeof db.transaction === 'function') {
      return db.transaction(callback);
    }

    await db.query('BEGIN');
    try {
      const result = await callback(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  };

  // PGLite runs in-process; serializing write transactions makes the
  // check-and-set sections explicit and prevents overlapping BEGIN/COMMIT
  // sequences if the driver is used in fallback mode.
  const previous = transactionQueue;
  let release;
  transactionQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ NULL,
      booking_id TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_holds_status_expires ON holds(status, expires_at)');

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  const count = Number(countResult.rows[0]?.count || 0);
  if (count === 0) {
    await inTransaction(async (tx) => {
      for (const rowLabel of ROWS) {
        for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
          const id = `${rowLabel}-${seatNumber}`;
          await tx.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [id, rowLabel, seatNumber, 'available'],
          );
        }
      }
    });
  }
}

async function releaseExpiredInTx(tx) {
  const expiredSeats = await tx.query(`
    SELECT id, hold_id
    FROM seats
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= CURRENT_TIMESTAMP
    ORDER BY row_label, seat_number
  `);

  if (expiredSeats.rows.length === 0) return [];

  await tx.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= CURRENT_TIMESTAMP
  `);

  await tx.query(`
    UPDATE holds
    SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active'
      AND expires_at <= CURRENT_TIMESTAMP
  `);

  return expiredSeats.rows.map((row) => ({
    id: row.id,
    status: 'available',
    holdId: null,
    holdExpiresAt: null,
    bookedBy: null,
    reason: 'expired',
  }));
}

async function sweepExpiredHolds() {
  const changes = await inTransaction((tx) => releaseExpiredInTx(tx));
  broadcastSeatChanges(changes, 'expired');
  return changes;
}

async function loadSeatsAndInventory() {
  const seatsResult = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    ORDER BY row_label, seat_number
  `);
  const seats = seatsResult.rows.map(mapSeat);
  const inventory = seats.reduce(
    (acc, seat) => {
      acc[seat.status] += 1;
      acc.total += 1;
      return acc;
    },
    { available: 0, held: 0, booked: 0, total: 0 },
  );
  return { seats, inventory };
}

async function conflictingSeatIds(seatIds) {
  if (seatIds.length === 0) return [];
  await sweepExpiredHolds();
  const result = await db.query(
    `SELECT id, status FROM seats WHERE id IN (${sqlPlaceholders(seatIds)})`,
    seatIds,
  );
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  return seatIds.filter((id) => !rowsById.has(id) || rowsById.get(id).status !== 'available');
}

function broadcastSeatChanges(changes, reason = 'changed') {
  if (!changes || changes.length === 0 || sseClients.size === 0) return;
  const payload = JSON.stringify({
    type: 'seat-changes',
    reason,
    changes,
    serverTime: new Date().toISOString(),
  });
  for (const client of sseClients) {
    client.write(`event: seat-changes\ndata: ${payload}\n\n`);
  }
}

setInterval(() => {
  sweepExpiredHolds().catch((error) => {
    console.error('expiry sweep failed', error);
  });
}, 1000).unref();

setInterval(() => {
  for (const client of sseClients) {
    client.write(`event: heartbeat\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`);
  }
}, 25000).unref();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    await sweepExpiredHolds();
    const { seats, inventory } = await loadSeatsAndInventory();
    res.json({
      seats,
      inventory,
      holdTtlSeconds: HOLD_TTL_SECONDS,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  const seatIds = normalizeSeatIds(req.body?.seatIds);
  const sessionId = String(req.body?.sessionId || '').trim();

  if (!sessionId) return next(new ApiError(400, 'sessionId is required'));
  if (seatIds.length === 0) return next(new ApiError(400, 'At least one seatId is required'));

  try {
    const txResult = await inTransaction(async (tx) => {
      const expiredChanges = await releaseExpiredInTx(tx);
      const existing = await tx.query(
        `SELECT id, status FROM seats WHERE id IN (${sqlPlaceholders(seatIds)})`,
        seatIds,
      );
      const rowsById = new Map(existing.rows.map((row) => [row.id, row]));
      const initialConflicts = seatIds.filter((id) => !rowsById.has(id) || rowsById.get(id).status !== 'available');
      if (initialConflicts.length > 0) {
        return { conflict: true, conflictSeatIds: initialConflicts, expiredChanges };
      }

      const holdId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
      await tx.query(
        `INSERT INTO holds (id, session_id, seat_ids, status, expires_at)
         VALUES ($1, $2, $3, 'active', $4)`,
        [holdId, sessionId, JSON.stringify(seatIds), expiresAt],
      );

      const updateResult = await tx.query(
        `UPDATE seats
         SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${sqlPlaceholders(seatIds, 3)})
           AND status = 'available'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [holdId, expiresAt, ...seatIds],
      );

      if (updateResult.rows.length !== seatIds.length) {
        throw new TransactionConflict(seatIds);
      }

      const hold = { id: holdId, sessionId, seatIds, status: 'active', expiresAt, bookingId: null };
      const heldChanges = updateResult.rows.map((row) => ({ ...mapSeat(row), reason: 'held' }));
      return { conflict: false, hold, heldChanges, expiredChanges };
    });

    broadcastSeatChanges(txResult.expiredChanges, 'expired');

    if (txResult.conflict) {
      return res.status(409).json({
        error: 'seats_unavailable',
        message: 'One or more requested seats are unavailable',
        conflictSeatIds: txResult.conflictSeatIds,
      });
    }

    broadcastSeatChanges(txResult.heldChanges, 'held');
    return res.status(201).json({ hold: txResult.hold, serverTime: new Date().toISOString() });
  } catch (error) {
    if (error instanceof TransactionConflict) {
      try {
        const conflictIds = await conflictingSeatIds(seatIds);
        return res.status(409).json({
          error: 'seats_unavailable',
          message: 'One or more requested seats are unavailable',
          conflictSeatIds: conflictIds.length > 0 ? conflictIds : seatIds,
        });
      } catch (innerError) {
        return next(innerError);
      }
    }
    return next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  const holdId = String(req.params.holdId || '').trim();
  const sessionId = String(req.body?.sessionId || '').trim();

  if (!sessionId) return next(new ApiError(400, 'sessionId is required'));

  try {
    const txResult = await inTransaction(async (tx) => {
      const expiredChanges = await releaseExpiredInTx(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      const hold = mapHold(holdResult.rows[0]);
      if (!hold) throw new ApiError(404, 'Unknown hold');
      if (hold.sessionId !== sessionId) throw new ApiError(403, 'Hold belongs to a different session');

      if (hold.status === 'confirmed') {
        return { expiredChanges, idempotent: true, booking: { bookingId: hold.bookingId, holdId: hold.id, seatIds: hold.seatIds } };
      }
      if (hold.status !== 'active') {
        throw new ApiError(409, `Hold is ${hold.status} and cannot be confirmed`);
      }
      if (new Date(hold.expiresAt).getTime() <= Date.now()) {
        await tx.query("UPDATE holds SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'active'", [hold.id]);
        await tx.query(`
          UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE hold_id = $1 AND status = 'held'
        `, [hold.id]);
        throw new ApiError(409, 'Hold has expired');
      }

      const ownedSeats = await tx.query(
        `SELECT id FROM seats
         WHERE hold_id = $1 AND status = 'held'
         ORDER BY id`,
        [hold.id],
      );
      if (ownedSeats.rows.length !== hold.seatIds.length) {
        throw new ApiError(409, 'Hold no longer owns all requested seats');
      }

      const bookingId = hold.bookingId || `booking_${hold.id}`;
      const updateResult = await tx.query(
        `UPDATE seats
         SET status = 'booked', hold_id = NULL, booked_by = $2, hold_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [hold.id, sessionId],
      );

      await tx.query(
        `UPDATE holds
         SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, booking_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [hold.id, bookingId],
      );

      return {
        expiredChanges,
        idempotent: false,
        booking: { bookingId, holdId: hold.id, seatIds: hold.seatIds },
        bookedChanges: updateResult.rows.map((row) => ({ ...mapSeat(row), reason: 'booked' })),
      };
    });

    broadcastSeatChanges(txResult.expiredChanges, 'expired');
    broadcastSeatChanges(txResult.bookedChanges, 'booked');
    res.json({ booking: txResult.booking, idempotent: txResult.idempotent, serverTime: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  const holdId = String(req.params.holdId || '').trim();
  const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();

  if (!sessionId) return next(new ApiError(400, 'sessionId is required'));

  try {
    const txResult = await inTransaction(async (tx) => {
      const expiredChanges = await releaseExpiredInTx(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      const hold = mapHold(holdResult.rows[0]);
      if (!hold) throw new ApiError(404, 'Unknown hold');
      if (hold.sessionId !== sessionId) throw new ApiError(403, 'Hold belongs to a different session');

      if (hold.status !== 'active') {
        return { expiredChanges, releasedChanges: [], hold: { ...hold, status: hold.status } };
      }

      const released = await tx.query(
        `UPDATE seats
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE hold_id = $1 AND status = 'held'
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
        [hold.id],
      );
      await tx.query("UPDATE holds SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [hold.id]);

      return {
        expiredChanges,
        hold: { ...hold, status: 'released' },
        releasedChanges: released.rows.map((row) => ({ ...mapSeat(row), reason: 'released' })),
      };
    });

    broadcastSeatChanges(txResult.expiredChanges, 'expired');
    broadcastSeatChanges(txResult.releasedChanges, 'released');
    res.json({ hold: txResult.hold, releasedSeatIds: txResult.releasedChanges.map((seat) => seat.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`);

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(rootDir, 'client', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.details?.error || (status >= 500 ? 'internal_error' : 'request_error'),
    message: err.message || 'Unexpected error',
    ...(err.details || {}),
  });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_DIR}`);
});
