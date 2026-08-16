import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);

const db = new PGlite(path.join(__dirname, 'data'));

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const clients = new Set();
let writeChain = Promise.resolve();

function isoNow() {
  return new Date().toISOString();
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function sqlList(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(', ');
}

function queueExclusive(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

async function transaction(fn) {
  return queueExclusive(async () => {
    await db.query('BEGIN');
    try {
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {
        // Ignore rollback failures; the original error is more useful.
      }
      throw err;
    }
  });
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT NULL,
      hold_expires_at TEXT NULL,
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
      status TEXT NOT NULL CHECK (status IN ('held', 'booked', 'released', 'expired')),
      expires_at TEXT NOT NULL,
      seat_ids TEXT NOT NULL,
      booking_id TEXT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT NULL,
      released_at TEXT NULL
    );
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
          [`${row}-${n}`, row, n, 'available'],
        );
      }
    }
  }
}

function parseSeatIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > 50) return null;
  return ids;
}

function seatRowsForEvent(rows, status, extra = {}) {
  return rows.map((s) => ({
    id: s.id,
    rowLabel: s.row_label,
    seatNumber: s.seat_number,
    status,
    holdId: status === 'held' ? s.hold_id : (status === 'booked' ? s.hold_id : null),
    holdExpiresAt: status === 'held' ? s.hold_expires_at : null,
    bookedBy: status === 'booked' ? s.booked_by : null,
    ...extra,
  }));
}

async function sweepExpiredInTx(tx) {
  const now = isoNow();
  const expired = await tx.query(
    `SELECT id, row_label, seat_number, hold_id, hold_expires_at, booked_by
       FROM seats
      WHERE status = 'held' AND hold_expires_at <= $1
      ORDER BY row_label, seat_number`,
    [now],
  );

  if (expired.rows.length === 0) return [];

  const holdIds = [...new Set(expired.rows.map((r) => r.hold_id))];
  await tx.query(
    `UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
      WHERE status = 'held' AND hold_expires_at <= $1`,
    [now],
  );
  await tx.query(
    `UPDATE holds
        SET status = 'expired', released_at = $1
      WHERE status = 'held' AND id IN (${sqlList(holdIds, 2)})`,
    [now, ...holdIds],
  );

  return seatRowsForEvent(expired.rows, 'available', { reason: 'expired' });
}

async function inventorySnapshot() {
  // Serialized with writes so the count is never read mid-transaction.
  return queueExclusive(async () => {
    const result = await db.query(`
      SELECT status, COUNT(*)::int AS count
        FROM seats
       GROUP BY status
    `);
    const inventory = { available: 0, held: 0, booked: 0, total: 0 };
    for (const row of result.rows) {
      inventory[row.status] = Number(row.count);
      inventory.total += Number(row.count);
    }
    return inventory;
  });
}

async function broadcast(type, seats, inventory = null) {
  if (!seats || seats.length === 0 || clients.size === 0) return;
  const payload = JSON.stringify({ type, seats, inventory: inventory || await inventorySnapshot(), at: isoNow() });
  for (const res of clients) {
    res.write(`event: seat-update\ndata: ${payload}\n\n`);
  }
}

async function sweepExpiredAndBroadcast() {
  const released = await transaction(async (tx) => sweepExpiredInTx(tx));
  await broadcast('released', released);
  return released;
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

async function inventoryInTx(tx) {
  const result = await tx.query(`
    SELECT status, COUNT(*)::int AS count
      FROM seats
     GROUP BY status
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

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ at: isoNow() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const result = await transaction(async (tx) => {
      const released = await sweepExpiredInTx(tx);
      const seats = await tx.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
          FROM seats
         ORDER BY row_label, seat_number
      `);
      return { released, seats: seats.rows.map(publicSeat), inventory: await inventoryInTx(tx) };
    });
    await broadcast('released', result.released);
    res.json({ seats: result.seats, inventory: result.inventory, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = parseSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!seatIds || !sessionId) {
      res.status(400).json({ error: 'seatIds (1-50 unique ids) and sessionId are required' });
      return;
    }

    const outcome = await transaction(async (tx) => {
      const released = await sweepExpiredInTx(tx);
      const selected = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          WHERE id IN (${sqlList(seatIds)})`,
        seatIds,
      );
      const byId = new Map(selected.rows.map((r) => [r.id, r]));
      const conflicts = seatIds.filter((id) => !byId.has(id) || byId.get(id).status !== 'available');

      if (conflicts.length > 0 || selected.rows.length !== seatIds.length) {
        return { ok: false, status: 409, conflicts, released, inventory: await inventoryInTx(tx) };
      }

      const holdId = crypto.randomUUID();
      const expiresAt = isoIn(HOLD_TTL_MS);
      const now = isoNow();
      await tx.query(
        `INSERT INTO holds (id, session_id, status, expires_at, seat_ids, created_at)
         VALUES ($1, $2, 'held', $3, $4, $5)`,
        [holdId, sessionId, expiresAt, JSON.stringify(seatIds), now],
      );
      await tx.query(
        `UPDATE seats
            SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
          WHERE id IN (${sqlList(seatIds, 3)}) AND status = 'available'`,
        [holdId, expiresAt, ...seatIds],
      );
      const heldRows = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          WHERE id IN (${sqlList(seatIds)})
          ORDER BY row_label, seat_number`,
        seatIds,
      );
      return {
        ok: true,
        released,
        hold: { id: holdId, sessionId, seatIds, expiresAt },
        seats: heldRows.rows.map(publicSeat),
        inventory: await inventoryInTx(tx),
      };
    });

    await broadcast('released', outcome.released);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: 'One or more seats are unavailable', conflicts: outcome.conflicts });
      return;
    }
    await broadcast('held', outcome.seats, outcome.inventory);
    res.status(201).json({ hold: outcome.hold, seats: outcome.seats, inventory: outcome.inventory });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId || !sessionId) {
      res.status(400).json({ error: 'hold id and sessionId are required' });
      return;
    }

    const outcome = await transaction(async (tx) => {
      const released = await sweepExpiredInTx(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) return { ok: false, status: 404, error: 'Unknown hold', released };

      const hold = holdResult.rows[0];
      if (sessionId && hold.session_id !== sessionId) {
        return { ok: false, status: 403, error: 'Hold belongs to a different session', released };
      }

      const seatIds = JSON.parse(hold.seat_ids);

      if (hold.status === 'booked') {
        const seats = await tx.query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
             FROM seats WHERE hold_id = $1 AND status = 'booked'
             ORDER BY row_label, seat_number`,
          [holdId],
        );
        return {
          ok: true,
          idempotent: true,
          released,
          booking: { id: hold.booking_id, holdId, sessionId: hold.session_id, seatIds, confirmedAt: hold.confirmed_at },
          seats: seats.rows.map(publicSeat),
          broadcastSeats: [],
          inventory: await inventoryInTx(tx),
        };
      }

      if (hold.status !== 'held' || hold.expires_at <= isoNow()) {
        return { ok: false, status: 409, error: 'Hold is expired, released, or otherwise not confirmable', released };
      }

      const seatResult = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          WHERE id IN (${sqlList(seatIds)})
          ORDER BY row_label, seat_number`,
        seatIds,
      );
      const ownsAllSeats = seatResult.rows.length === seatIds.length
        && seatResult.rows.every((s) => s.status === 'held' && s.hold_id === holdId && s.hold_expires_at === hold.expires_at);
      if (!ownsAllSeats) {
        return { ok: false, status: 409, error: 'Hold no longer owns all requested seats', released };
      }

      const bookingId = crypto.randomUUID();
      const confirmedAt = isoNow();
      await tx.query(
        `UPDATE seats
            SET status = 'booked', hold_expires_at = NULL, booked_by = $1
          WHERE hold_id = $2 AND status = 'held'`,
        [hold.session_id, holdId],
      );
      await tx.query(
        `UPDATE holds
            SET status = 'booked', booking_id = $1, confirmed_at = $2
          WHERE id = $3`,
        [bookingId, confirmedAt, holdId],
      );
      const bookedRows = await tx.query(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
           FROM seats
          WHERE hold_id = $1 AND status = 'booked'
          ORDER BY row_label, seat_number`,
        [holdId],
      );
      return {
        ok: true,
        released,
        booking: { id: bookingId, holdId, sessionId: hold.session_id, seatIds, confirmedAt },
        seats: bookedRows.rows.map(publicSeat),
        broadcastSeats: bookedRows.rows.map(publicSeat),
        inventory: await inventoryInTx(tx),
      };
    });

    await broadcast('released', outcome.released);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    await broadcast('booked', outcome.broadcastSeats, outcome.inventory);
    res.json({ booking: outcome.booking, seats: outcome.seats, idempotent: Boolean(outcome.idempotent), inventory: outcome.inventory });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();

    const outcome = await transaction(async (tx) => {
      const expiredReleased = await sweepExpiredInTx(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) return { ok: false, status: 404, error: 'Unknown hold', expiredReleased };
      const hold = holdResult.rows[0];
      if (sessionId && hold.session_id !== sessionId) {
        return { ok: false, status: 403, error: 'Hold belongs to a different session', expiredReleased };
      }
      if (hold.status !== 'held') {
        return { ok: true, alreadyDone: true, expiredReleased, releasedSeats: [], inventory: await inventoryInTx(tx) };
      }

      const heldSeats = await tx.query(
        `SELECT id, row_label, seat_number, hold_id, hold_expires_at, booked_by
           FROM seats WHERE hold_id = $1 AND status = 'held'
           ORDER BY row_label, seat_number`,
        [holdId],
      );
      await tx.query(
        `UPDATE seats
            SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
          WHERE hold_id = $1 AND status = 'held'`,
        [holdId],
      );
      await tx.query(
        `UPDATE holds SET status = 'released', released_at = $1 WHERE id = $2 AND status = 'held'`,
        [isoNow(), holdId],
      );
      return { ok: true, expiredReleased, releasedSeats: seatRowsForEvent(heldSeats.rows, 'available', { reason: 'released' }), inventory: await inventoryInTx(tx) };
    });

    await broadcast('released', outcome.expiredReleased);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    await broadcast('released', outcome.releasedSeats, outcome.inventory);
    res.json({ ok: true, released: outcome.releasedSeats, inventory: outcome.inventory });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err) });
});

await initDb();
setInterval(() => {
  sweepExpiredAndBroadcast().catch((err) => console.error('expiry sweep failed', err));
}, 1_000);

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
  console.log(`Seat map: ${ROWS.length * SEATS_PER_ROW} seats, hold TTL ${HOLD_TTL_MS}ms`);
});
