import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const db = new PGlite(path.join(__dirname, '..', 'pglite-data'));
const app = express();
const distDir = path.join(__dirname, '..', 'dist');

app.use(cors());
app.use(express.json({ limit: '64kb' }));

const sseClients = new Set();

class Mutex {
  constructor() {
    this.queue = Promise.resolve();
  }

  async run(fn) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
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

const dbMutex = new Mutex();

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of sseClients) {
    sendEvent(client, event, data);
  }
}

function normalizeSeat(row) {
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

function seatUpdate(row, status = row.status) {
  return {
    id: row.id,
    status,
    holdId: row.hold_id ?? null,
    holdExpiresAt: row.hold_expires_at ?? null,
    bookedBy: row.booked_by ?? null,
  };
}

function placeholders(values, start = 1) {
  return values.map((_, index) => `$${index + start}`).join(', ');
}

function validateSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const error = new Error('seatIds must be a non-empty array');
    error.status = 400;
    throw error;
  }

  const unique = [...new Set(seatIds.map((id) => String(id)))];
  if (unique.length > 20) {
    const error = new Error('A hold may contain at most 20 seats');
    error.status = 400;
    throw error;
  }

  for (const id of unique) {
    if (!/^[A-Z]-\d{1,2}$/.test(id)) {
      const error = new Error(`Invalid seat id: ${id}`);
      error.status = 400;
      throw error;
    }
  }

  return unique;
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
      booked_by TEXT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TIMESTAMPTZ NULL,
      booking_id TEXT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL REFERENCES holds(id),
      seat_id TEXT NOT NULL REFERENCES seats(id),
      PRIMARY KEY (hold_id, seat_id)
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  const count = Number(countResult.rows[0]?.count ?? 0);
  if (count === 0) {
    await db.query('BEGIN;');
    try {
      for (const row of ROWS) {
        for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
          const id = `${row}-${seatNumber}`;
          await db.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4);',
            [id, row, seatNumber, 'available'],
          );
        }
      }
      await db.query('COMMIT;');
    } catch (error) {
      await db.query('ROLLBACK;');
      throw error;
    }
  }
}

async function sweepExpiredHoldsInTransaction() {
  const expired = await db.query(`
    UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE status = 'held'
       AND hold_expires_at <= CURRENT_TIMESTAMP
     RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;
  `);

  await db.query(`
    UPDATE holds
       SET status = 'expired'
     WHERE status = 'held'
       AND expires_at <= CURRENT_TIMESTAMP;
  `);

  return expired.rows.map((row) => seatUpdate(row, 'available'));
}

async function withTransaction(fn) {
  return dbMutex.run(async () => {
    const broadcasts = [];
    await db.query('BEGIN;');
    try {
      const released = await sweepExpiredHoldsInTransaction();
      if (released.length > 0) {
        broadcasts.push({ event: 'seats', data: { type: 'released', seats: released } });
      }

      const result = await fn({ broadcasts });
      await db.query('COMMIT;');

      for (const item of broadcasts) {
        broadcast(item.event, item.data);
      }
      return result;
    } catch (error) {
      await db.query('ROLLBACK;');
      throw error;
    }
  });
}

async function sweepExpiredHolds() {
  return withTransaction(async () => ({ ok: true }));
}

async function getHoldResponse(holdId) {
  const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
  const hold = holdResult.rows[0];
  if (!hold) return null;

  const seatsResult = await db.query(
    `SELECT s.*
       FROM seats s
       JOIN hold_seats hs ON hs.seat_id = s.id
      WHERE hs.hold_id = $1
      ORDER BY s.row_label, s.seat_number;`,
    [holdId],
  );

  return {
    id: hold.id,
    sessionId: hold.session_id,
    status: hold.status,
    expiresAt: hold.expires_at,
    confirmedAt: hold.confirmed_at,
    bookingId: hold.booking_id,
    ttlSeconds: HOLD_TTL_SECONDS,
    seats: seatsResult.rows.map(normalizeSeat),
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  sendEvent(res, 'connected', { now: new Date().toISOString() });

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

app.get('/api/seats', async (req, res, next) => {
  try {
    await sweepExpiredHolds();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM seats
       ORDER BY row_label, seat_number;
    `);

    const seats = result.rows.map(normalizeSeat);
    const inventory = seats.reduce(
      (acc, seat) => {
        acc[seat.status] += 1;
        return acc;
      },
      { total: seats.length, available: 0, held: 0, booked: 0 },
    );

    res.json({ seats, inventory, holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = validateSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const result = await withTransaction(async ({ broadcasts }) => {
      const selected = await db.query(
        `SELECT * FROM seats WHERE id IN (${placeholders(seatIds)}) ORDER BY id;`,
        seatIds,
      );

      const foundIds = new Set(selected.rows.map((row) => row.id));
      const conflicts = seatIds.filter((id) => !foundIds.has(id));
      for (const row of selected.rows) {
        if (row.status !== 'available') conflicts.push(row.id);
      }

      if (conflicts.length > 0 || selected.rows.length !== seatIds.length) {
        const uniqueConflicts = [...new Set(conflicts)];
        const error = new Error('One or more seats are unavailable');
        error.status = 409;
        error.payload = { error: error.message, conflictingSeatIds: uniqueConflicts };
        throw error;
      }

      const holdId = crypto.randomUUID();
      const expiresResult = await db.query(
        `INSERT INTO holds (id, session_id, status, expires_at)
         VALUES ($1, $2, 'held', CURRENT_TIMESTAMP + ($3::text || ' seconds')::interval)
         RETURNING *;`,
        [holdId, sessionId, String(HOLD_TTL_SECONDS)],
      );
      const hold = expiresResult.rows[0];

      for (const seatId of seatIds) {
        await db.query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2);', [holdId, seatId]);
      }

      const updated = await db.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${placeholders(seatIds, 3)})
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
        [holdId, hold.expires_at, ...seatIds],
      );

      const updates = updated.rows.map((row) => seatUpdate(row, 'held'));
      broadcasts.push({ event: 'seats', data: { type: 'held', seats: updates } });

      return {
        hold: {
          id: hold.id,
          sessionId: hold.session_id,
          status: hold.status,
          expiresAt: hold.expires_at,
          ttlSeconds: HOLD_TTL_SECONDS,
          seats: updated.rows.map(normalizeSeat),
        },
      };
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || '').trim();

    const result = await withTransaction(async ({ broadcasts }) => {
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
      const hold = holdResult.rows[0];

      if (!hold) {
        const error = new Error('Unknown hold');
        error.status = 404;
        throw error;
      }
      if (sessionId && hold.session_id !== sessionId) {
        const error = new Error('Hold belongs to a different session');
        error.status = 403;
        throw error;
      }

      if (hold.status === 'confirmed') {
        return { booking: await getHoldResponse(holdId) };
      }
      if (hold.status !== 'held') {
        const error = new Error(`Cannot confirm a ${hold.status} hold`);
        error.status = 409;
        throw error;
      }

      const ownedSeats = await db.query(
        `SELECT s.*
           FROM seats s
           JOIN hold_seats hs ON hs.seat_id = s.id
          WHERE hs.hold_id = $1
          ORDER BY s.row_label, s.seat_number;`,
        [holdId],
      );

      const invalidSeat = ownedSeats.rows.find((seat) => seat.status !== 'held' || seat.hold_id !== holdId);
      if (invalidSeat) {
        const error = new Error('Hold is no longer active for all seats');
        error.status = 409;
        throw error;
      }

      const bookingId = crypto.randomUUID();
      await db.query(
        `UPDATE holds
            SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, booking_id = $2
          WHERE id = $1;`,
        [holdId, bookingId],
      );

      const seatIds = ownedSeats.rows.map((seat) => seat.id);
      const booked = await db.query(
        `UPDATE seats
            SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $1
          WHERE hold_id = $2
            AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
        [hold.session_id, holdId],
      );

      if (booked.rows.length !== seatIds.length) {
        const error = new Error('Hold could not be confirmed atomically');
        error.status = 409;
        throw error;
      }

      broadcasts.push({
        event: 'seats',
        data: { type: 'booked', seats: booked.rows.map((row) => seatUpdate(row, 'booked')) },
      });

      return { booking: await getHoldResponse(holdId) };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();

    const result = await withTransaction(async ({ broadcasts }) => {
      const holdResult = await db.query('SELECT * FROM holds WHERE id = $1;', [holdId]);
      const hold = holdResult.rows[0];
      if (!hold) return { released: false, reason: 'unknown' };
      if (sessionId && hold.session_id !== sessionId) {
        const error = new Error('Hold belongs to a different session');
        error.status = 403;
        throw error;
      }
      if (hold.status !== 'held') {
        return { released: false, reason: hold.status };
      }

      await db.query("UPDATE holds SET status = 'released' WHERE id = $1;", [holdId]);
      const released = await db.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL
          WHERE hold_id = $1
            AND status = 'held'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by;`,
        [holdId],
      );

      const updates = released.rows.map((row) => seatUpdate(row, 'available'));
      if (updates.length > 0) {
        broadcasts.push({ event: 'seats', data: { type: 'released', seats: updates } });
      }

      return { released: true, seats: updates };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json(error.payload || { error: error.message || 'Internal server error' });
});

await initDb();
setInterval(() => {
  sweepExpiredHolds().catch((error) => console.error('expiry sweep failed', error));
}, 5_000);

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
});
