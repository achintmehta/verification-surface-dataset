import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const dataDir = process.env.PGLITE_DATA_DIR || path.join(projectRoot, 'data', 'pglite');
fs.mkdirSync(dataDir, { recursive: true });
const db = new PGlite(dataDir);
const sseClients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function rowCount(result) {
  return Number(result?.affectedRows ?? result?.rowsAffected ?? result?.rowCount ?? 0);
}

function sqlArray(values) {
  return values.map((_, i) => `$${i + 1}`).join(',');
}

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) {
    const err = new Error('seatIds must be an array');
    err.status = 400;
    throw err;
  }
  const ids = [...new Set(input.map((v) => String(v).trim()).filter(Boolean))];
  if (ids.length === 0) {
    const err = new Error('At least one seat is required');
    err.status = 400;
    throw err;
  }
  if (ids.length > 50) {
    const err = new Error('Too many seats requested');
    err.status = 400;
    throw err;
  }
  return ids;
}

function normalizeSessionId(input) {
  const sessionId = String(input || '').trim();
  if (!sessionId || sessionId.length > 128) {
    const err = new Error('sessionId is required');
    err.status = 400;
    throw err;
  }
  return sessionId;
}

async function q(sql, params = []) {
  return db.query(sql, params);
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((status = 'held') = (hold_id IS NOT NULL AND hold_expires_at IS NOT NULL)),
      CHECK (status <> 'booked' OR booked_by IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT[] NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      booking_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_status_expires ON holds(status, expires_at);
  `);

  const count = await q('SELECT COUNT(*)::int AS count FROM seats');
  if (Number(count.rows[0]?.count || 0) === 0) {
    await q('BEGIN');
    try {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
          const id = `${row}${n}`;
          await q(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')`,
            [id, row, n]
          );
        }
      }
      await q('COMMIT');
    } catch (err) {
      await q('ROLLBACK');
      throw err;
    }
  }
}

function seatPayload(row) {
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

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function getSeatsByIds(ids) {
  if (!ids.length) return [];
  const result = await q(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
     FROM seats WHERE id IN (${sqlArray(ids)})
     ORDER BY row_label, seat_number`,
    ids
  );
  return result.rows.map(seatPayload);
}

async function sweepExpiredHoldsLocked() {
  await q('BEGIN');
  try {
    const expired = await q(
      `SELECT id, seat_ids FROM holds
       WHERE status = 'active' AND expires_at <= NOW()`
    );
    const releasedSeatIds = [];
    for (const hold of expired.rows) {
      const seatIds = hold.seat_ids || [];
      if (seatIds.length) {
        const params = [hold.id, ...seatIds];
        await q(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, updated_at = NOW()
           WHERE hold_id = $1 AND status = 'held' AND id IN (${seatIds.map((_, i) => `$${i + 2}`).join(',')})`,
          params
        );
        releasedSeatIds.push(...seatIds);
      }
      await q(`UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'`, [hold.id]);
    }
    await q('COMMIT');
    if (releasedSeatIds.length) {
      const seats = await getSeatsByIds([...new Set(releasedSeatIds)]);
      broadcast('seats', { type: 'released', seats });
    }
    return releasedSeatIds;
  } catch (err) {
    await q('ROLLBACK');
    throw err;
  }
}

async function sweepExpiredHolds() {
  return enqueueWrite(sweepExpiredHoldsLocked);
}

async function currentInventory() {
  const result = await q(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'held' AND hold_expires_at > NOW())::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  return result.rows[0];
}

app.get('/api/health', async (_req, res, next) => {
  try {
    const inventory = await enqueueWrite(async () => {
      await sweepExpiredHoldsLocked();
      return currentInventory();
    });
    res.json({ ok: true, inventory });
  } catch (err) {
    next(err);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const body = await enqueueWrite(async () => {
      await sweepExpiredHoldsLocked();
      const result = await q(
        `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
         FROM seats
         ORDER BY row_label, seat_number`
      );
      return { seats: result.rows.map(seatPayload), inventory: await currentInventory(), holdTtlMs: HOLD_TTL_MS };
    });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = normalizeSessionId(req.body?.sessionId);
    const response = await enqueueWrite(async () => {
      await sweepExpiredHoldsLocked();
      const holdId = randomUUID();
      await q('BEGIN');
      try {
        const placeholders = sqlArray(seatIds);
        const existing = await q(`SELECT id FROM seats WHERE id IN (${placeholders})`, seatIds);
        if (existing.rows.length !== seatIds.length) {
          const found = new Set(existing.rows.map((r) => r.id));
          const missing = seatIds.filter((id) => !found.has(id));
          await q('ROLLBACK');
          return { status: 404, body: { error: 'Unknown seat ids', missingSeatIds: missing } };
        }

        const conflicts = await q(
          `SELECT id FROM seats
           WHERE id IN (${placeholders}) AND status <> 'available'
           ORDER BY id`,
          seatIds
        );
        if (conflicts.rows.length) {
          await q('ROLLBACK');
          return {
            status: 409,
            body: { error: 'One or more seats are unavailable', conflictingSeatIds: conflicts.rows.map((r) => r.id) }
          };
        }

        const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
        const update = await q(
          `UPDATE seats
           SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL, updated_at = NOW()
           WHERE id IN (${seatIds.map((_, i) => `$${i + 3}`).join(',')}) AND status = 'available'`,
          [holdId, expiresAt, ...seatIds]
        );
        if (rowCount(update) !== seatIds.length) {
          const nowConflicts = await q(
            `SELECT id FROM seats WHERE id IN (${placeholders}) AND status <> 'available' ORDER BY id`,
            seatIds
          );
          await q('ROLLBACK');
          return {
            status: 409,
            body: { error: 'One or more seats are unavailable', conflictingSeatIds: nowConflicts.rows.map((r) => r.id) }
          };
        }

        await q(
          `INSERT INTO holds (id, session_id, seat_ids, status, expires_at)
           VALUES ($1, $2, $3, 'active', $4)`,
          [holdId, sessionId, seatIds, expiresAt]
        );
        await q('COMMIT');
        const seats = await getSeatsByIds(seatIds);
        return {
          status: 201,
          body: { hold: { id: holdId, sessionId, seatIds, expiresAt, status: 'active' }, seats }
        };
      } catch (err) {
        await q('ROLLBACK');
        throw err;
      }
    });
    if (response.status === 201) broadcast('seats', { type: 'held', seats: response.body.seats, hold: response.body.hold });
    res.status(response.status).json(response.body);
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = req.body?.sessionId ? normalizeSessionId(req.body.sessionId) : null;
    const response = await enqueueWrite(async () => {
      await sweepExpiredHoldsLocked();
      await q('BEGIN');
      try {
        const result = await q('SELECT * FROM holds WHERE id = $1', [holdId]);
        const hold = result.rows[0];
        if (!hold) {
          await q('ROLLBACK');
          return { status: 404, body: { error: 'Unknown hold' } };
        }
        if (sessionId && hold.session_id !== sessionId) {
          await q('ROLLBACK');
          return { status: 403, body: { error: 'Hold belongs to another session' } };
        }
        const seatIds = hold.seat_ids || [];
        if (hold.status === 'confirmed') {
          await q('ROLLBACK');
          const seats = await getSeatsByIds(seatIds);
          return {
            status: 200,
            body: { booking: { id: hold.booking_id, holdId, sessionId: hold.session_id, seatIds, confirmedAt: hold.confirmed_at }, seats, idempotent: true }
          };
        }
        if (hold.status !== 'active') {
          await q('ROLLBACK');
          return { status: 409, body: { error: `Hold is ${hold.status}` } };
        }

        const expiry = await q('SELECT ($1::timestamptz <= NOW()) AS expired', [hold.expires_at]);
        if (expiry.rows[0]?.expired) {
          await q('ROLLBACK');
          return { status: 409, body: { error: 'Hold has expired' } };
        }

        const placeholders = sqlArray(seatIds);
        const owned = await q(
          `SELECT id FROM seats
           WHERE id IN (${placeholders}) AND status = 'held' AND hold_id = $${seatIds.length + 1}
           ORDER BY id`,
          [...seatIds, holdId]
        );
        if (owned.rows.length !== seatIds.length) {
          await q('ROLLBACK');
          return { status: 409, body: { error: 'Hold no longer owns all requested seats' } };
        }

        const bookingId = hold.booking_id || randomUUID();
        const confirmedAt = new Date().toISOString();
        await q(
          `UPDATE seats
           SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL, updated_at = NOW()
           WHERE hold_id = $2 AND status = 'held'`,
          [hold.session_id, holdId]
        );
        await q(
          `UPDATE holds
           SET status = 'confirmed', confirmed_at = $1, booking_id = $2
           WHERE id = $3`,
          [confirmedAt, bookingId, holdId]
        );
        await q('COMMIT');
        const seats = await getSeatsByIds(seatIds);
        return {
          status: 200,
          body: { booking: { id: bookingId, holdId, sessionId: hold.session_id, seatIds, confirmedAt }, seats, idempotent: false }
        };
      } catch (err) {
        await q('ROLLBACK');
        throw err;
      }
    });
    if (response.status === 200 && !response.body.idempotent) {
      broadcast('seats', { type: 'booked', seats: response.body.seats, booking: response.body.booking });
    }
    res.status(response.status).json(response.body);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = req.body?.sessionId || req.query?.sessionId;
    const normalizedSession = sessionId ? normalizeSessionId(sessionId) : null;
    const response = await enqueueWrite(async () => {
      await sweepExpiredHoldsLocked();
      await q('BEGIN');
      try {
        const result = await q('SELECT * FROM holds WHERE id = $1', [holdId]);
        const hold = result.rows[0];
        if (!hold) {
          await q('ROLLBACK');
          return { status: 404, body: { error: 'Unknown hold' } };
        }
        if (normalizedSession && hold.session_id !== normalizedSession) {
          await q('ROLLBACK');
          return { status: 403, body: { error: 'Hold belongs to another session' } };
        }
        if (hold.status !== 'active') {
          await q('ROLLBACK');
          return { status: 200, body: { hold: { id: holdId, status: hold.status }, seats: [] } };
        }
        const seatIds = hold.seat_ids || [];
        await q(
          `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, updated_at = NOW()
           WHERE hold_id = $1 AND status = 'held'`,
          [holdId]
        );
        await q(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
        await q('COMMIT');
        const seats = await getSeatsByIds(seatIds);
        return { status: 200, body: { hold: { id: holdId, status: 'released' }, seats } };
      } catch (err) {
        await q('ROLLBACK');
        throw err;
      }
    });
    if (response.body?.seats?.length) broadcast('seats', { type: 'released', seats: response.body.seats, hold: response.body.hold });
    res.status(response.status).json(response.body);
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, now: new Date().toISOString() })}\n\n`);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = Number(err.status || 500);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

await initDb();
setInterval(() => sweepExpiredHolds().catch((err) => console.error('expiry sweep failed', err)), 1000).unref();
setInterval(() => {
  const ping = `event: ping\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) res.write(ping);
}, 15_000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking API listening on http://localhost:${PORT}`);
});
