import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'pglite');
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const db = new PGlite(DATABASE_PATH);
const clients = new Set();

class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  async run(fn) {
    const previous = this._tail;
    let release;
    this._tail = new Promise((resolve) => {
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

function placeholders(count, offset = 1) {
  return Array.from({ length: count }, (_, i) => `$${i + offset}`).join(', ');
}

function normalizeSeatIds(seatIds) {
  if (!Array.isArray(seatIds)) return [];
  return [...new Set(seatIds.map((id) => String(id).trim()).filter(Boolean))];
}

function validateSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.length <= 128;
}

function publicSeat(row) {
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

function inventoryFromSeats(seats) {
  return seats.reduce(
    (acc, seat) => {
      acc[seat.status] += 1;
      acc.total += 1;
      return acc;
    },
    { available: 0, held: 0, booked: 0, total: 0 }
  );
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    sendSse(client, event, data);
  }
}

function broadcastSeatChanges(seats, reason) {
  if (!seats.length) return;
  broadcast('seat-change', { reason, seats: seats.map(publicSeat) });
}

async function tx(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS hold_seats (
      hold_id TEXT NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
      seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
      PRIMARY KEY (hold_id, seat_id)
    );
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    await tx(async () => {
      for (const row of ROWS) {
        for (let seat = 1; seat <= SEATS_PER_ROW; seat += 1) {
          const id = `${row}-${seat}`;
          await db.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')
             ON CONFLICT (id) DO NOTHING`,
            [id, row, seat]
          );
        }
      }
    });
  }
}

async function sweepExpiredHolds() {
  return writeMutex.run(async () => {
    const expiredSeats = await tx(async () => {
      const before = await db.query(`
        SELECT s.*
        FROM seats s
        JOIN holds h ON h.id = s.hold_id
        WHERE s.status = 'held'
          AND h.status = 'active'
          AND h.expires_at <= now()
        ORDER BY s.row_label, s.seat_number
      `);

      await db.query(`
        UPDATE seats s
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL
        FROM holds h
        WHERE h.id = s.hold_id
          AND s.status = 'held'
          AND h.status = 'active'
          AND h.expires_at <= now()
      `);

      await db.query(`
        UPDATE holds
        SET status = 'expired'
        WHERE status = 'active'
          AND expires_at <= now()
      `);

      if (before.rows.length === 0) return [];
      const ids = before.rows.map((row) => row.id);
      const after = await db.query(
        `SELECT * FROM seats WHERE id IN (${placeholders(ids.length)}) ORDER BY row_label, seat_number`,
        ids
      );
      return after.rows;
    });

    broadcastSeatChanges(expiredSeats, 'expired');
    return expiredSeats;
  });
}

async function getAllSeats() {
  await sweepExpiredHolds();
  const result = await db.query('SELECT * FROM seats ORDER BY row_label, seat_number');
  const seats = result.rows.map(publicSeat);
  return { seats, inventory: inventoryFromSeats(seats) };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    res.json(await getAllSeats());
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();

    if (seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must contain at least one seat id' });
    }
    if (!validateSessionId(sessionId)) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const result = await writeMutex.run(async () => {
      await sweepExpiredHoldsUnlocked();
      return tx(async () => {
        const selected = await db.query(
          `SELECT * FROM seats WHERE id IN (${placeholders(seatIds.length)}) ORDER BY row_label, seat_number`,
          seatIds
        );
        const found = new Map(selected.rows.map((row) => [row.id, row]));
        const conflicts = [];

        for (const id of seatIds) {
          const seat = found.get(id);
          if (!seat || seat.status !== 'available') conflicts.push(id);
        }

        if (conflicts.length > 0) {
          return { conflict: true, conflicts };
        }

        const holdId = crypto.randomUUID();
        const holdInsert = await db.query(
          `INSERT INTO holds (id, session_id, status, expires_at)
           VALUES ($1, $2, 'active', now() + ($3::text)::interval)
           RETURNING id, session_id, status, expires_at, created_at`,
          [holdId, sessionId, `${HOLD_TTL_SECONDS} seconds`]
        );
        const hold = holdInsert.rows[0];

        for (const seatId of seatIds) {
          await db.query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)', [holdId, seatId]);
        }

        const update = await db.query(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
           WHERE id IN (${placeholders(seatIds.length, 3)}) AND status = 'available'
           RETURNING *`,
          [holdId, hold.expires_at, ...seatIds]
        );

        if (update.rows.length !== seatIds.length) {
          throw new Error('Atomic hold failed because not every requested seat was updated');
        }

        return { conflict: false, hold, seats: update.rows };
      });
    });

    if (result.conflict) {
      return res.status(409).json({ error: 'One or more requested seats are unavailable', conflicts: result.conflicts });
    }

    broadcastSeatChanges(result.seats, 'held');
    return res.status(201).json({
      hold: {
        id: result.hold.id,
        sessionId: result.hold.session_id,
        status: result.hold.status,
        expiresAt: result.hold.expires_at,
        ttlSeconds: HOLD_TTL_SECONDS,
        seatIds: result.seats.map((seat) => seat.id)
      },
      seats: result.seats.map(publicSeat)
    });
  } catch (error) {
    next(error);
  }
});

async function sweepExpiredHoldsUnlocked() {
  const expiredSeats = await tx(async () => {
    const before = await db.query(`
      SELECT s.*
      FROM seats s
      JOIN holds h ON h.id = s.hold_id
      WHERE s.status = 'held'
        AND h.status = 'active'
        AND h.expires_at <= now()
      ORDER BY s.row_label, s.seat_number
    `);

    await db.query(`
      UPDATE seats s
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      FROM holds h
      WHERE h.id = s.hold_id
        AND s.status = 'held'
        AND h.status = 'active'
        AND h.expires_at <= now()
    `);

    await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= now()
    `);

    if (before.rows.length === 0) return [];
    const ids = before.rows.map((row) => row.id);
    const after = await db.query(
      `SELECT * FROM seats WHERE id IN (${placeholders(ids.length)}) ORDER BY row_label, seat_number`,
      ids
    );
    return after.rows;
  });
  broadcastSeatChanges(expiredSeats, 'expired');
  return expiredSeats;
}

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId) return res.status(400).json({ error: 'holdId is required' });
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'sessionId is required' });

    const result = await writeMutex.run(async () => {
      await sweepExpiredHoldsUnlocked();
      return tx(async () => {
        const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (holdResult.rows.length === 0) return { error: 'Hold not found', status: 404 };
        const hold = holdResult.rows[0];
        if (hold.session_id !== sessionId) return { error: 'Hold belongs to a different session', status: 403 };

        const heldSeatRows = await db.query(
          `SELECT s.*
           FROM seats s
           JOIN hold_seats hs ON hs.seat_id = s.id
           WHERE hs.hold_id = $1
           ORDER BY s.row_label, s.seat_number`,
          [holdId]
        );

        if (hold.status === 'confirmed') {
          return { confirmed: true, alreadyConfirmed: true, hold, seats: heldSeatRows.rows };
        }
        if (hold.status !== 'active') return { error: `Hold is ${hold.status}`, status: 409 };

        const expiryCheck = await db.query('SELECT ($1::timestamptz > now()) AS active', [hold.expires_at]);
        if (!expiryCheck.rows[0].active) return { error: 'Hold has expired', status: 409 };

        const invalidSeats = heldSeatRows.rows.filter((seat) => seat.status !== 'held' || seat.hold_id !== holdId);
        if (invalidSeats.length > 0 || heldSeatRows.rows.length === 0) {
          return { error: 'Hold no longer owns every requested seat', status: 409 };
        }

        await db.query(
          `UPDATE seats
           SET status = 'booked', booked_by = $2, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId, sessionId]
        );
        const confirmedHold = await db.query(
          `UPDATE holds
           SET status = 'confirmed', confirmed_at = now()
           WHERE id = $1
           RETURNING *`,
          [holdId]
        );
        const bookedSeats = await db.query(
          `SELECT s.*
           FROM seats s
           JOIN hold_seats hs ON hs.seat_id = s.id
           WHERE hs.hold_id = $1
           ORDER BY s.row_label, s.seat_number`,
          [holdId]
        );
        return { confirmed: true, alreadyConfirmed: false, hold: confirmedHold.rows[0], seats: bookedSeats.rows };
      });
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyConfirmed) broadcastSeatChanges(result.seats, 'booked');

    return res.json({
      booking: {
        holdId: result.hold.id,
        sessionId: result.hold.session_id,
        status: result.hold.status,
        confirmedAt: result.hold.confirmed_at,
        seatIds: result.seats.map((seat) => seat.id)
      },
      idempotent: Boolean(result.alreadyConfirmed),
      seats: result.seats.map(publicSeat)
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!holdId) return res.status(400).json({ error: 'holdId is required' });
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'sessionId is required' });

    const result = await writeMutex.run(async () => {
      await sweepExpiredHoldsUnlocked();
      return tx(async () => {
        const holdResult = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (holdResult.rows.length === 0) return { error: 'Hold not found', status: 404 };
        const hold = holdResult.rows[0];
        if (hold.session_id !== sessionId) return { error: 'Hold belongs to a different session', status: 403 };
        if (hold.status === 'confirmed') return { error: 'Confirmed holds cannot be released', status: 409 };
        if (hold.status !== 'active') return { released: true, alreadyReleased: true, seats: [] };

        await db.query("UPDATE holds SET status = 'released' WHERE id = $1", [holdId]);
        const released = await db.query(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE hold_id = $1 AND status = 'held'
           RETURNING *`,
          [holdId]
        );
        return { released: true, alreadyReleased: false, seats: released.rows };
      });
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastSeatChanges(result.seats, 'released');
    return res.json({ released: true, idempotent: Boolean(result.alreadyReleased), seats: result.seats.map(publicSeat) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'hello', { connected: true, holdTtlSeconds: HOLD_TTL_SECONDS });

  const heartbeat = setInterval(() => {
    sendSse(res, 'ping', { now: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

await initDb();
setInterval(() => {
  sweepExpiredHolds().catch((error) => console.error('expiry sweep failed', error));
}, 1000).unref?.();

app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
  console.log(`PGLite data path: ${DATABASE_PATH}`);
});
