import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';

const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 1000);

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async run(fn) {
    let release;
    const previous = this.tail;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const writeMutex = new Mutex();
const sseClients = new Set();

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeSeat(row) {
  return {
    id: Number(row.id),
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id ?? null,
    holdExpiresAt: toIso(row.hold_expires_at),
    bookedBy: row.booked_by ?? null,
    bookedAt: toIso(row.booked_at)
  };
}

function normalizeHold(row, seats = []) {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    confirmedAt: toIso(row.confirmed_at),
    releasedAt: toIso(row.released_at),
    bookingId: row.booking_id ?? null,
    seatCount: Number(row.seat_count),
    seats
  };
}

function placeholders(values, offset = 1) {
  return values.map((_, index) => `$${index + offset}`).join(', ');
}

async function selectSeats(ids = null) {
  if (ids && ids.length > 0) {
    const result = await db.query(
      `SELECT * FROM seats WHERE id IN (${placeholders(ids)}) ORDER BY id`,
      ids
    );
    return result.rows.map(normalizeSeat);
  }
  const result = await db.query('SELECT * FROM seats ORDER BY id');
  return result.rows.map(normalizeSeat);
}

async function inventory() {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'held')::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  const row = result.rows[0] || {};
  return {
    total: Number(row.total || 0),
    available: Number(row.available || 0),
    held: Number(row.held || 0),
    booked: Number(row.booked || 0)
  };
}

async function sweepExpiredHoldsLocked() {
  const expired = await db.query(`
    SELECT * FROM seats
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    ORDER BY id
  `);

  if (expired.rows.length === 0) return [];

  const releasedSnapshots = expired.rows.map((row) => normalizeSeat({
    ...row,
    status: 'available',
    hold_id: null,
    hold_expires_at: null
  }));
  const holdIds = [...new Set(expired.rows.map((row) => row.hold_id).filter(Boolean))];

  await db.query('BEGIN');
  try {
    if (holdIds.length > 0) {
      await db.query(
        `UPDATE holds
           SET status = 'expired', released_at = COALESCE(released_at, NOW())
         WHERE status = 'active' AND id IN (${placeholders(holdIds)})`,
        holdIds
      );
    }

    await db.query(
      `UPDATE seats
          SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        WHERE status = 'held'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= NOW()`
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  return releasedSnapshots;
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

async function sweepAndBroadcast() {
  await initDb();
  const releasedSeats = await writeMutex.run(async () => sweepExpiredHoldsLocked());
  if (releasedSeats.length > 0) {
    broadcast('seats', {
      action: 'released',
      seats: releasedSeats,
      inventory: await inventory()
    });
  }
}

function httpError(status, code, message, extra = {}) {
  return { status, body: { error: code, message, ...extra } };
}

function validateSeatIds(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw httpError(400, 'invalid_seat_ids', 'seatIds must be a non-empty array.');
  }
  const unique = [...new Set(input.map((id) => Number(id)))];
  if (unique.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw httpError(400, 'invalid_seat_ids', 'seatIds must contain positive integer ids.');
  }
  return unique;
}

function validateSessionId(input) {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 200) {
    throw httpError(400, 'invalid_session_id', 'sessionId is required.');
  }
  return input.trim();
}

app.get('/api/health', async (_req, res, next) => {
  try {
    await initDb();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    await initDb();
    const { releasedSeats, seats, counts } = await writeMutex.run(async () => {
      const releasedSeats = await sweepExpiredHoldsLocked();
      return {
        releasedSeats,
        seats: await selectSeats(),
        counts: await inventory()
      };
    });

    if (releasedSeats.length > 0) {
      broadcast('seats', { action: 'released', seats: releasedSeats, inventory: counts });
    }

    res.json({ seats, inventory: counts, holdTtlMs: HOLD_TTL_MS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  let changedSeats = [];
  let counts;
  try {
    await initDb();
    const seatIds = validateSeatIds(req.body?.seatIds);
    const sessionId = validateSessionId(req.body?.sessionId);

    const result = await writeMutex.run(async () => {
      const releasedSeats = await sweepExpiredHoldsLocked();
      const existing = await db.query(
        `SELECT * FROM seats WHERE id IN (${placeholders(seatIds)}) ORDER BY id`,
        seatIds
      );

      const foundIds = new Set(existing.rows.map((row) => Number(row.id)));
      const missingIds = seatIds.filter((id) => !foundIds.has(id));
      const unavailable = existing.rows
        .filter((row) => row.status !== 'available')
        .map((row) => Number(row.id));
      const conflicts = [...new Set([...missingIds, ...unavailable])].sort((a, b) => a - b);

      if (conflicts.length > 0) {
        return { conflict: conflicts, releasedSeats, counts: await inventory() };
      }

      const holdId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO holds (id, session_id, status, expires_at, seat_count)
           VALUES ($1, $2, 'active', $3, $4)`,
          [holdId, sessionId, expiresAt, seatIds.length]
        );
        await db.query(
          `UPDATE seats
              SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}, booked_by = NULL, booked_at = NULL
            WHERE id IN (${placeholders(seatIds)}) AND status = 'available'`,
          [...seatIds, holdId, expiresAt]
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }

      const seats = await selectSeats(seatIds);
      return {
        hold: {
          id: holdId,
          sessionId,
          status: 'active',
          expiresAt,
          seatCount: seatIds.length,
          seats
        },
        seats,
        releasedSeats,
        counts: await inventory()
      };
    });

    counts = result.counts;
    if (result.releasedSeats?.length) {
      broadcast('seats', { action: 'released', seats: result.releasedSeats, inventory: counts });
    }
    if (result.conflict) {
      return res.status(409).json({
        error: 'seats_unavailable',
        message: 'One or more requested seats are not available; no seats were held.',
        conflictingSeatIds: result.conflict,
        inventory: counts
      });
    }

    changedSeats = result.seats;
    broadcast('seats', { action: 'held', holdId: result.hold.id, seats: changedSeats, inventory: counts });
    res.status(201).json({ hold: result.hold, inventory: counts });
  } catch (error) {
    if (error?.status) return res.status(error.status).json(error.body);
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    await initDb();
    const holdId = req.params.holdId;
    const suppliedSessionId = req.body?.sessionId;

    const result = await writeMutex.run(async () => {
      const releasedSeats = await sweepExpiredHoldsLocked();
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      const hold = holdResult.rows[0];

      if (!hold) {
        return { notFound: true, releasedSeats, counts: await inventory() };
      }
      if (suppliedSessionId !== undefined && validateSessionId(suppliedSessionId) !== hold.session_id) {
        return { forbidden: true, releasedSeats, counts: await inventory() };
      }
      if (hold.status === 'confirmed') {
        const bookedSeats = await selectSeatsByHold(holdId);
        return {
          idempotent: true,
          hold: normalizeHold(hold, bookedSeats),
          seats: bookedSeats,
          releasedSeats,
          counts: await inventory()
        };
      }
      if (hold.status !== 'active') {
        return { invalid: hold.status, releasedSeats, counts: await inventory() };
      }
      if (new Date(hold.expires_at).getTime() <= Date.now()) {
        return { invalid: 'expired', releasedSeats, counts: await inventory() };
      }

      const heldSeats = await selectSeatsByHold(holdId);
      if (heldSeats.length !== Number(hold.seat_count) || heldSeats.some((seat) => seat.status !== 'held')) {
        return { invalid: 'seat_mismatch', releasedSeats, counts: await inventory() };
      }

      const bookingId = hold.booking_id || crypto.randomUUID();
      const ids = heldSeats.map((seat) => seat.id);

      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE seats
              SET status = 'booked', booked_by = $1, booked_at = NOW(), hold_expires_at = NULL
            WHERE hold_id = $2 AND status = 'held'`,
          [hold.session_id, holdId]
        );
        await db.query(
          `UPDATE holds
              SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, NOW()), booking_id = $1
            WHERE id = $2 AND status = 'active'`,
          [bookingId, holdId]
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }

      const seats = await selectSeats(ids);
      const refreshedHold = (await db.query('SELECT * FROM holds WHERE id = $1', [holdId])).rows[0];
      return {
        confirmed: true,
        hold: normalizeHold(refreshedHold, seats),
        seats,
        releasedSeats,
        counts: await inventory()
      };
    });

    if (result.releasedSeats?.length) {
      broadcast('seats', { action: 'released', seats: result.releasedSeats, inventory: result.counts });
    }
    if (result.notFound) {
      return res.status(404).json({ error: 'unknown_hold', message: 'Hold does not exist.', inventory: result.counts });
    }
    if (result.forbidden) {
      return res.status(403).json({ error: 'wrong_session', message: 'This hold belongs to a different session.', inventory: result.counts });
    }
    if (result.invalid) {
      return res.status(409).json({ error: 'invalid_hold', message: `Hold cannot be confirmed (${result.invalid}).`, inventory: result.counts });
    }

    if (result.confirmed) {
      broadcast('seats', { action: 'booked', holdId, seats: result.seats, inventory: result.counts });
    }
    res.json({ hold: result.hold, bookingId: result.hold.bookingId, idempotent: Boolean(result.idempotent), inventory: result.counts });
  } catch (error) {
    if (error?.status) return res.status(error.status).json(error.body);
    next(error);
  }
});

async function selectSeatsByHold(holdId) {
  const result = await db.query('SELECT * FROM seats WHERE hold_id = $1 ORDER BY id', [holdId]);
  return result.rows.map(normalizeSeat);
}

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    await initDb();
    const holdId = req.params.holdId;

    const result = await writeMutex.run(async () => {
      const releasedByExpiry = await sweepExpiredHoldsLocked();
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      const hold = holdResult.rows[0];
      if (!hold) return { notFound: true, releasedByExpiry, counts: await inventory() };
      if (hold.status === 'confirmed') return { confirmed: true, releasedByExpiry, counts: await inventory() };
      if (hold.status !== 'active') return { alreadyReleased: true, releasedByExpiry, counts: await inventory() };

      const currentlyHeld = await selectSeatsByHold(holdId);

      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await db.query(
          `UPDATE holds SET status = 'released', released_at = COALESCE(released_at, NOW())
            WHERE id = $1 AND status = 'active'`,
          [holdId]
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }

      const released = currentlyHeld.map((seat) => ({
        ...seat,
        status: 'available',
        holdId: null,
        holdExpiresAt: null
      }));

      return {
        released,
        releasedByExpiry,
        counts: await inventory()
      };
    });

    if (result.releasedByExpiry?.length) {
      broadcast('seats', { action: 'released', seats: result.releasedByExpiry, inventory: result.counts });
    }
    if (result.notFound) return res.status(404).json({ error: 'unknown_hold', message: 'Hold does not exist.', inventory: result.counts });
    if (result.confirmed) return res.status(409).json({ error: 'already_confirmed', message: 'A confirmed hold cannot be released.', inventory: result.counts });
    if (result.alreadyReleased) return res.json({ released: false, seats: [], inventory: result.counts });

    broadcast('seats', { action: 'released', holdId, seats: result.released, inventory: result.counts });
    res.json({ released: true, seats: result.released, inventory: result.counts });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  await initDb();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ holdTtlMs: HOLD_TTL_MS })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal_error', message: 'Unexpected server error.' });
});

await initDb();
setInterval(() => {
  sweepAndBroadcast().catch((error) => console.error('expiry sweep failed', error));
}, SWEEP_INTERVAL_MS).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
