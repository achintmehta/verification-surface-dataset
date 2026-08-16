import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 1000);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dist')));

const db = new PGlite(path.join(__dirname, '..', 'pgdata'));
const sseClients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function sqlArray(ids) {
  return `{${ids.map((id) => String(id).replace(/"/g, '')).join(',')}}`;
}

function normalizeSeat(row) {
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

function normalizeHold(row, seatIds = undefined) {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    seatIds: seatIds ?? row.seat_ids ?? []
  };
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastSeatChanges(type, seats, extra = {}) {
  if (!seats || seats.length === 0) return;
  const payload = {
    type,
    seats: seats.map(normalizeSeat),
    ...extra
  };
  broadcast('seat-change', payload);
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'expired', 'released')),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')) DEFAULT 'available',
      hold_id TEXT REFERENCES holds(id),
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_expiry ON seats(hold_expires_at);
    CREATE INDEX IF NOT EXISTS idx_holds_status_expiry ON holds(status, expires_at);
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (countResult.rows[0].count === 0) {
    await db.transaction(async (tx) => {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
          await tx.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [`${row}${n}`, row, n, 'available']
          );
        }
      }
    });
  }
}

async function expireHolds(tx) {
  const expiredSeatsResult = await tx.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
    FROM seats
    WHERE status = 'held' AND hold_expires_at <= now()
    ORDER BY row_label, seat_number
  `);

  if (expiredSeatsResult.rows.length === 0) {
    await tx.query("UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at <= now()");
    return [];
  }

  await tx.query(`
    UPDATE holds
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= now()
  `);

  const releasedResult = await tx.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
    WHERE status = 'held' AND hold_expires_at <= now()
    RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
  `);

  return releasedResult.rows;
}

async function sweepExpiredAndBroadcast() {
  try {
    const released = await enqueueWrite(async () => db.transaction(async (tx) => expireHolds(tx)));
    broadcastSeatChanges('released', released);
  } catch (err) {
    console.error('expiry sweep failed', err);
  }
}

async function getSeats() {
  return enqueueWrite(async () => db.transaction(async (tx) => {
    const released = await expireHolds(tx);
    const seatsResult = await tx.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);
    return { released, seats: seatsResult.rows };
  }));
}

async function getInventory() {
  return enqueueWrite(async () => db.transaction(async (tx) => {
    const released = await expireHolds(tx);
    const result = await tx.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available,
        COUNT(*) FILTER (WHERE status = 'held')::int AS held,
        COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
      FROM seats
    `);
    return { released, inventory: result.rows[0] };
  }));
}

function validateSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { ok: false, message: 'seatIds must be a non-empty array' };
  }
  const unique = [...new Set(seatIds.map((id) => String(id).trim()).filter(Boolean))];
  if (unique.length !== seatIds.length) {
    return { ok: false, message: 'seatIds must be unique and non-empty' };
  }
  return { ok: true, seatIds: unique };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    const { released, seats } = await getSeats();
    broadcastSeatChanges('released', released);
    res.json({ seats: seats.map(normalizeSeat) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    const { released, inventory } = await getInventory();
    broadcastSeatChanges('released', released);
    res.json({ inventory });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const validation = validateSeatIds(req.body.seatIds);
    const sessionId = String(req.body.sessionId || '').trim();
    if (!validation.ok) return res.status(400).json({ error: validation.message });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

    const result = await enqueueWrite(async () => db.transaction(async (tx) => {
      const released = await expireHolds(tx);
      const seatIds = validation.seatIds;
      const seatArray = sqlArray(seatIds);

      const existingResult = await tx.query(
        'SELECT id, status FROM seats WHERE id = ANY($1::text[])',
        [seatArray]
      );
      const existingIds = new Set(existingResult.rows.map((row) => row.id));
      const missing = seatIds.filter((id) => !existingIds.has(id));

      const conflictResult = await tx.query(
        "SELECT id FROM seats WHERE id = ANY($1::text[]) AND status <> 'available' ORDER BY id",
        [seatArray]
      );
      const conflicts = [...missing, ...conflictResult.rows.map((row) => row.id)];

      if (missing.length > 0 || conflictResult.rows.length > 0 || existingResult.rows.length !== seatIds.length) {
        return { ok: false, status: 409, released, conflicts: [...new Set(conflicts)] };
      }

      await tx.query(
        "INSERT INTO holds (id, session_id, status, expires_at) VALUES ($1, $2, 'active', $3)",
        [holdId, sessionId, expiresAt]
      );

      const updatedResult = await tx.query(`
        UPDATE seats
        SET status = 'held', hold_id = $2, hold_expires_at = $3, booked_by = NULL
        WHERE id = ANY($1::text[]) AND status = 'available'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `, [seatArray, holdId, expiresAt]);

      if (updatedResult.rows.length !== seatIds.length) {
        throw new Error('Atomic hold acquisition failed; no seats were committed');
      }

      return {
        ok: true,
        released,
        hold: { id: holdId, session_id: sessionId, status: 'active', expires_at: expiresAt, confirmed_at: null, seat_ids: seatIds },
        seats: updatedResult.rows
      };
    }));

    broadcastSeatChanges('released', result.released);
    if (!result.ok) {
      return res.status(result.status).json({ error: 'One or more seats are unavailable', conflictingSeatIds: result.conflicts });
    }
    broadcastSeatChanges('held', result.seats, { holdId: result.hold.id, expiresAt: result.hold.expires_at });
    res.status(201).json({ hold: normalizeHold(result.hold), seats: result.seats.map(normalizeSeat), ttlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await enqueueWrite(async () => db.transaction(async (tx) => {
      const released = await expireHolds(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) {
        return { ok: false, status: 404, released, error: 'Unknown hold' };
      }
      const hold = holdResult.rows[0];
      if (hold.session_id !== sessionId) {
        return { ok: false, status: 403, released, error: 'Hold belongs to a different session' };
      }

      if (hold.status === 'confirmed') {
        const bookedSeats = await tx.query(`
          SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
          FROM seats WHERE hold_id = $1 AND status = 'booked' ORDER BY row_label, seat_number
        `, [holdId]);
        return { ok: true, idempotent: true, released, hold, seats: bookedSeats.rows };
      }

      if (hold.status !== 'active') {
        return { ok: false, status: 409, released, error: `Hold is ${hold.status}` };
      }

      const activeSeats = await tx.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM seats
        WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now()
        ORDER BY row_label, seat_number
      `, [holdId]);

      if (activeSeats.rows.length === 0) {
        await tx.query("UPDATE holds SET status = 'expired' WHERE id = $1 AND status = 'active'", [holdId]);
        return { ok: false, status: 409, released, error: 'Hold has expired' };
      }

      const bookedResult = await tx.query(`
        UPDATE seats
        SET status = 'booked', booked_by = $2, hold_expires_at = NULL
        WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > now()
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `, [holdId, sessionId]);

      if (bookedResult.rows.length !== activeSeats.rows.length) {
        throw new Error('Confirm failed because hold ownership changed during transaction');
      }

      const updatedHold = await tx.query(
        "UPDATE holds SET status = 'confirmed', confirmed_at = now() WHERE id = $1 RETURNING *",
        [holdId]
      );

      return { ok: true, released, hold: updatedHold.rows[0], seats: bookedResult.rows };
    }));

    broadcastSeatChanges('released', result.released);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (!result.idempotent) broadcastSeatChanges('booked', result.seats, { holdId });
    res.json({ hold: normalizeHold(result.hold, result.seats.map((s) => s.id)), seats: result.seats.map(normalizeSeat), idempotent: !!result.idempotent });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();

    const result = await enqueueWrite(async () => db.transaction(async (tx) => {
      const releasedByExpiry = await expireHolds(tx);
      const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
      if (holdResult.rows.length === 0) return { ok: false, status: 404, releasedByExpiry, error: 'Unknown hold' };
      const hold = holdResult.rows[0];
      if (sessionId && hold.session_id !== sessionId) return { ok: false, status: 403, releasedByExpiry, error: 'Hold belongs to a different session' };
      if (hold.status === 'confirmed') return { ok: false, status: 409, releasedByExpiry, error: 'Confirmed holds cannot be released' };

      const releasedResult = await tx.query(`
        UPDATE seats
        SET status = 'available', hold_id = NULL, hold_expires_at = NULL, booked_by = NULL
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `, [holdId]);

      await tx.query("UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'", [holdId]);
      return { ok: true, releasedByExpiry, released: releasedResult.rows };
    }));

    broadcastSeatChanges('released', result.releasedByExpiry);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    broadcastSeatChanges('released', result.released);
    res.json({ releasedSeatIds: result.released.map((seat) => seat.id), seats: result.released.map(normalizeSeat) });
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

await initDb();
setInterval(sweepExpiredAndBroadcast, SWEEP_INTERVAL_MS).unref();
app.listen(PORT, () => {
  console.log(`Seat booking server listening on http://localhost:${PORT}`);
});
