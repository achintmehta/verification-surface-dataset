import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT || 3000;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);
const DB_PATH = process.env.PGLITE_DATA_DIR || './pglite-data';

const db = new PGlite(DB_PATH);

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async run(fn) {
    const previous = this.tail;
    let release;
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

const mutationMutex = new Mutex();
const clients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function addMsIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function placeholders(values, start = 1) {
  return values.map((_, index) => `$${start + index}`).join(', ');
}

function normalizeSeatIds(seatIds) {
  if (!Array.isArray(seatIds)) return [];
  return [...new Set(seatIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

async function txQuery(sql, params = []) {
  return db.query(sql, params);
}

async function inTransaction(fn) {
  await txQuery('BEGIN');
  try {
    const result = await fn();
    await txQuery('COMMIT');
    return result;
  } catch (error) {
    await txQuery('ROLLBACK');
    throw error;
  }
}

function serializeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by
  };
}

async function getSeatsByIds(ids) {
  if (ids.length === 0) return [];
  const result = await txQuery(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
       FROM seats
      WHERE id IN (${placeholders(ids)})
      ORDER BY row_label, seat_number`,
    ids
  );
  return result.rows.map(serializeSeat);
}

async function getInventory() {
  const total = await txQuery('SELECT COUNT(*)::int AS total FROM seats');
  const available = await txQuery("SELECT COUNT(*)::int AS count FROM seats WHERE status = 'available'");
  const held = await txQuery("SELECT COUNT(*)::int AS count FROM seats WHERE status = 'held' AND hold_expires_at > $1", [nowIso()]);
  const booked = await txQuery("SELECT COUNT(*)::int AS count FROM seats WHERE status = 'booked'");
  return {
    total: total.rows[0].total,
    available: available.rows[0].count,
    held: held.rows[0].count,
    booked: booked.rows[0].count
  };
}

async function broadcastSeats(type, seats) {
  if (!seats || seats.length === 0 || clients.size === 0) return;
  const payload = JSON.stringify({ type, seats, inventory: await getInventory() });
  for (const client of clients) {
    client.write(`event: seat-update\ndata: ${payload}\n\n`);
  }
}

async function sweepExpiredHolds({ broadcast = true } = {}) {
  const expired = await inTransaction(async () => {
    const expiredSeatsResult = await txQuery(
      `SELECT id, hold_id
         FROM seats
        WHERE status = 'held'
          AND hold_expires_at <= $1
        ORDER BY id`,
      [nowIso()]
    );
    const expiredSeatIds = expiredSeatsResult.rows.map((row) => row.id);
    const expiredHoldIds = [...new Set(expiredSeatsResult.rows.map((row) => row.hold_id).filter(Boolean))];

    if (expiredSeatIds.length > 0) {
      await txQuery(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
          WHERE id IN (${placeholders(expiredSeatIds)})`,
        expiredSeatIds
      );
    }

    if (expiredHoldIds.length > 0) {
      await txQuery(
        `UPDATE holds
            SET status = 'expired'
          WHERE id IN (${placeholders(expiredHoldIds)})
            AND status = 'active'`,
        expiredHoldIds
      );
    }

    return expiredSeatIds.length > 0 ? getSeatsByIds(expiredSeatIds) : [];
  });

  if (broadcast && expired.length > 0) await broadcastSeats('released', expired);
  return expired;
}

async function initializeDatabase() {
  await txQuery(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TIMESTAMPTZ NULL,
      booked_by TEXT NULL,
      UNIQUE (row_label, seat_number)
    )
  `);

  await txQuery(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'booked', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      seat_ids JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      booked_at TIMESTAMPTZ NULL
    )
  `);

  const count = await txQuery('SELECT COUNT(*)::int AS count FROM seats');
  if (count.rows[0].count === 0) {
    await inTransaction(async () => {
      for (const row of ROWS) {
        for (let seat = 1; seat <= SEATS_PER_ROW; seat += 1) {
          await txQuery('INSERT INTO seats (row_label, seat_number) VALUES ($1, $2)', [row, seat]);
        }
      }
    });
  }

  await mutationMutex.run(() => sweepExpiredHolds({ broadcast: false }));
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/seats', async (req, res, next) => {
  try {
    const snapshot = await mutationMutex.run(async () => {
      await sweepExpiredHolds();
      return inTransaction(async () => {
        const result = await txQuery(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats
            ORDER BY row_label, seat_number`
        );
        return { seats: result.rows.map(serializeSeat), inventory: await getInventory(), holdTtlMs: HOLD_TTL_MS };
      });
    });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (seatIds.length === 0 || !sessionId) {
      return res.status(400).json({ error: 'seatIds and sessionId are required' });
    }

    const result = await mutationMutex.run(async () => {
      const changedByExpiry = await sweepExpiredHolds();
      return inTransaction(async () => {
        const selected = await txQuery(
          `SELECT id, status, hold_expires_at
             FROM seats
            WHERE id IN (${placeholders(seatIds)})
            ORDER BY id`,
          seatIds
        );

        const rowsById = new Map(selected.rows.map((row) => [row.id, row]));
        const conflicts = [];
        const missingSeatIds = [];
        for (const seatId of seatIds) {
          const row = rowsById.get(seatId);
          if (!row) missingSeatIds.push(seatId);
          else if (row.status !== 'available') conflicts.push(seatId);
        }

        if (missingSeatIds.length > 0) {
          return { ok: false, status: 400, body: { error: 'Unknown seat ids', unknownSeatIds: missingSeatIds }, changedByExpiry };
        }

        if (conflicts.length > 0) {
          return { ok: false, status: 409, body: { error: 'One or more seats are unavailable', conflictingSeatIds: conflicts }, changedByExpiry };
        }

        const holdId = randomUUID();
        const expiresAt = addMsIso(HOLD_TTL_MS);
        await txQuery(
          `INSERT INTO holds (id, session_id, status, expires_at, seat_ids)
           VALUES ($1, $2, 'active', $3, $4::jsonb)`,
          [holdId, sessionId, expiresAt, JSON.stringify(seatIds)]
        );
        await txQuery(
          `UPDATE seats
              SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
            WHERE id IN (${placeholders(seatIds, 3)})
              AND status = 'available'`,
          [holdId, expiresAt, ...seatIds]
        );
        const seats = await getSeatsByIds(seatIds);
        return { ok: true, body: { hold: { id: holdId, sessionId, seatIds, expiresAt }, seats }, changedByExpiry };
      });
    });

    if (!result.ok) return res.status(result.status).json(result.body);
    await broadcastSeats('held', result.body.seats);
    return res.status(201).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await mutationMutex.run(async () => {
      await sweepExpiredHolds();
      return inTransaction(async () => {
        const holdResult = await txQuery('SELECT * FROM holds WHERE id = $1', [holdId]);
        const hold = holdResult.rows[0];
        if (!hold) return { ok: false, status: 404, body: { error: 'Unknown hold' } };
        if (hold.session_id !== sessionId) return { ok: false, status: 403, body: { error: 'Hold belongs to a different session' } };

        const seatIds = Array.isArray(hold.seat_ids) ? hold.seat_ids : JSON.parse(hold.seat_ids);

        if (hold.status === 'booked') {
          const seats = await getSeatsByIds(seatIds);
          return { ok: true, type: 'idempotent', body: { booking: { holdId, sessionId, seatIds, bookedAt: hold.booked_at }, seats } };
        }

        if (hold.status !== 'active') {
          return { ok: false, status: 409, body: { error: `Hold is ${hold.status}` } };
        }

        if (new Date(hold.expires_at).getTime() <= Date.now()) {
          await txQuery("UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'", [holdId]);
          await txQuery(
            `UPDATE seats
                SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
              WHERE hold_id = $1
                AND status = 'held'`,
            [holdId]
          );
          const expiredSeats = await getSeatsByIds(seatIds);
          return { ok: false, status: 409, body: { error: 'Hold has expired' }, expiredSeats };
        }

        const heldSeats = await txQuery(
          `SELECT id
             FROM seats
            WHERE hold_id = $1
              AND status = 'held'
              AND hold_expires_at > $2
            ORDER BY id`,
          [holdId, nowIso()]
        );
        if (heldSeats.rows.length !== seatIds.length) {
          return { ok: false, status: 409, body: { error: 'Hold no longer owns all requested seats' } };
        }

        const bookedAt = nowIso();
        await txQuery(
          `UPDATE seats
              SET status = 'booked', hold_expires_at = NULL, booked_by = $2
            WHERE hold_id = $1
              AND status = 'held'`,
          [holdId, sessionId]
        );
        await txQuery("UPDATE holds SET status = 'booked', booked_at = $2 WHERE id = $1", [holdId, bookedAt]);
        const seats = await getSeatsByIds(seatIds);
        return { ok: true, type: 'booked', body: { booking: { holdId, sessionId, seatIds, bookedAt }, seats } };
      });
    });

    if (!result.ok) {
      if (result.expiredSeats?.length > 0) await broadcastSeats('released', result.expiredSeats);
      return res.status(result.status).json(result.body);
    }
    if (result.type === 'booked') await broadcastSeats('booked', result.body.seats);
    return res.json(result.body);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = req.params.holdId;
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await mutationMutex.run(async () => {
      await sweepExpiredHolds();
      return inTransaction(async () => {
        const holdResult = await txQuery('SELECT * FROM holds WHERE id = $1', [holdId]);
        const hold = holdResult.rows[0];
        if (!hold) return { ok: false, status: 404, body: { error: 'Unknown hold' } };
        const seatIds = Array.isArray(hold.seat_ids) ? hold.seat_ids : JSON.parse(hold.seat_ids);
        if (hold.status === 'active' && new Date(hold.expires_at).getTime() <= Date.now()) {
          await txQuery("UPDATE holds SET status = 'expired' WHERE id = $1", [holdId]);
          await txQuery(
            `UPDATE seats
                SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
              WHERE hold_id = $1
                AND status = 'held'`,
            [holdId]
          );
          const seats = await getSeatsByIds(seatIds);
          return { ok: true, body: { released: true, expired: true, seats } };
        }
        if (hold.session_id !== sessionId) return { ok: false, status: 403, body: { error: 'Hold belongs to a different session' } };
        if (hold.status !== 'active') return { ok: true, body: { released: false, seats: [] } };

        await txQuery("UPDATE holds SET status = 'released' WHERE id = $1", [holdId]);
        await txQuery(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
            WHERE hold_id = $1
              AND status = 'held'`,
          [holdId]
        );
        const seats = await getSeatsByIds(seatIds);
        return { ok: true, body: { released: true, seats } };
      });
    });

    if (!result.ok) return res.status(result.status).json(result.body);
    if (result.body.seats.length > 0) await broadcastSeats('released', result.body.seats);
    return res.json(result.body);
  } catch (error) {
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
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error) });
});

await initializeDatabase();
setInterval(() => {
  mutationMutex.run(() => sweepExpiredHolds()).catch((error) => console.error('expiry sweep failed', error));
}, 2_000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
});
