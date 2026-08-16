import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite');
const PORT = Number(process.env.PORT || 3000);
const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const db = new PGlite(DATA_DIR);
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const sseClients = new Set();
let txQueue = Promise.resolve();

function enqueue(fn) {
  const run = txQueue.then(fn, fn);
  txQueue = run.catch(() => {});
  return run;
}

function placeholders(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(', ');
}

function normalizeSeatIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
}

function publicSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.status === 'held' ? row.hold_id : null,
    holdExpiresAt: row.status === 'held' ? row.hold_expires_at : null,
    bookedBy: row.status === 'booked' ? row.booked_by : null
  };
}

function parseSeatIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function publicHold(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    seatIds: parseSeatIds(row.seat_ids),
    status: row.status,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at || null
  };
}

function broadcast(payload) {
  const body = `event: seats\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(body);
    } catch {
      sseClients.delete(res);
    }
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
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ NULL,
      released_at TIMESTAMPTZ NULL
    );

    CREATE INDEX IF NOT EXISTS seats_status_idx ON seats (status);
    CREATE INDEX IF NOT EXISTS seats_hold_id_idx ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS holds_status_expires_idx ON holds (status, expires_at);
  `);

  const count = await db.query('SELECT count(*)::int AS count FROM seats');
  if (Number(count.rows[0].count) === 0) {
    const values = [];
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) values.push(`${row}-${n}`, row, n);
    }
    const tuples = [];
    for (let i = 0; i < values.length; i += 3) {
      tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, 'available')`);
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${tuples.join(', ')}`,
      values
    );
  }
}

async function sweepExpiredHolds({ doBroadcast = true } = {}) {
  return enqueue(async () => {
    await db.query('BEGIN');
    try {
      const released = await db.query(`
        UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL
         WHERE status = 'held'
           AND hold_expires_at <= now()
         RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      `);
      await db.query(`
        UPDATE holds
           SET status = 'expired', released_at = COALESCE(released_at, now())
         WHERE status = 'active'
           AND expires_at <= now()
      `);
      await db.query('COMMIT');
      const seats = released.rows.map(publicSeat);
      if (doBroadcast && seats.length) broadcast({ type: 'released', seats });
      return seats;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
}

async function getAllSeats() {
  await sweepExpiredHolds();
  const result = await db.query(`
    SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats
     ORDER BY row_label, seat_number
  `);
  const seats = result.rows.map(publicSeat);
  const inventory = seats.reduce(
    (acc, seat) => {
      acc[seat.status] += 1;
      acc.total += 1;
      return acc;
    },
    { available: 0, held: 0, booked: 0, total: 0 }
  );
  return { seats, inventory, holdTtlSeconds: HOLD_TTL_SECONDS };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!seatIds.length) return res.status(400).json({ error: 'seatIds must be a non-empty array' });

    const result = await enqueue(async () => {
      await db.query('BEGIN');
      try {
        const released = await db.query(`
          UPDATE seats
             SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE status = 'held' AND hold_expires_at <= now()
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        `);
        await db.query(`
          UPDATE holds SET status = 'expired', released_at = COALESCE(released_at, now())
           WHERE status = 'active' AND expires_at <= now()
        `);

        const ph = placeholders(seatIds);
        const found = await db.query(`SELECT id FROM seats WHERE id IN (${ph}) FOR UPDATE`, seatIds);
        const foundSet = new Set(found.rows.map((r) => r.id));
        const missing = seatIds.filter((id) => !foundSet.has(id));
        if (missing.length) {
          await db.query('COMMIT');
          return {
            status: 400,
            body: { error: 'Unknown seat ids', missingSeatIds: missing },
            broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : []
          };
        }

        const conflictsRes = await db.query(
          `SELECT id FROM seats WHERE id IN (${ph}) AND status <> 'available' ORDER BY id`,
          seatIds
        );
        const conflicts = conflictsRes.rows.map((r) => r.id);
        if (conflicts.length) {
          await db.query('COMMIT');
          return {
            status: 409,
            body: { error: 'One or more seats are unavailable', conflictingSeatIds: conflicts },
            broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : []
          };
        }

        const holdId = randomUUID();
        const expires = await db.query(
          `SELECT (now() + ($1::int * interval '1 second')) AS expires_at`,
          [HOLD_TTL_SECONDS]
        );
        const expiresAt = expires.rows[0].expires_at;
        await db.query(
          'INSERT INTO holds (id, session_id, seat_ids, status, expires_at) VALUES ($1, $2, $3, $4, $5)',
          [holdId, sessionId, JSON.stringify(seatIds), 'active', expiresAt]
        );
        const updated = await db.query(
          `UPDATE seats
              SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}, booked_by = NULL
            WHERE id IN (${ph}) AND status = 'available'
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [...seatIds, holdId, expiresAt]
        );
        if (updated.rows.length !== seatIds.length) {
          await db.query('ROLLBACK');
          return { status: 409, body: { error: 'Seat acquisition failed; retry', conflictingSeatIds: seatIds } };
        }
        const holdRow = await db.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        await db.query('COMMIT');
        return {
          status: 201,
          body: { hold: publicHold(holdRow.rows[0]), seats: updated.rows.map(publicSeat) },
          broadcasts: [
            ...(released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : []),
            { type: 'held', holdId, seats: updated.rows.map(publicSeat) }
          ]
        };
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });

    if (result.broadcasts) result.broadcasts.forEach(broadcast);
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId).trim() : null;
    const result = await enqueue(async () => {
      await db.query('BEGIN');
      try {
        const released = await db.query(`
          UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
           WHERE status = 'held' AND hold_expires_at <= now()
           RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        `);
        await db.query(`
          UPDATE holds SET status = 'expired', released_at = COALESCE(released_at, now())
           WHERE status = 'active' AND expires_at <= now()
        `);

        const holdRes = await db.query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [holdId]);
        if (!holdRes.rows.length) {
          await db.query('COMMIT');
          return { status: 404, body: { error: 'Unknown hold' }, broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : [] };
        }
        const hold = holdRes.rows[0];
        if (sessionId && sessionId !== hold.session_id) {
          await db.query('COMMIT');
          return { status: 403, body: { error: 'Hold belongs to a different session' }, broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : [] };
        }
        if (hold.status === 'confirmed') {
          const booked = await db.query(
            'SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_number',
            [holdId]
          );
          await db.query('COMMIT');
          return { status: 200, body: { hold: publicHold(hold), seats: booked.rows.map(publicSeat), idempotent: true }, broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : [] };
        }
        if (hold.status !== 'active') {
          await db.query('COMMIT');
          return { status: 409, body: { error: `Hold is ${hold.status}` }, broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : [] };
        }
        const activeCheck = await db.query('SELECT expires_at > now() AS active FROM holds WHERE id = $1', [holdId]);
        if (!activeCheck.rows[0].active) {
          await db.query('COMMIT');
          return { status: 409, body: { error: 'Hold has expired' }, broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : [] };
        }

        const seatIds = parseSeatIds(hold.seat_ids);
        const ph = placeholders(seatIds, 2);
        const owned = await db.query(
          `SELECT count(*)::int AS count FROM seats WHERE hold_id = $1 AND status = 'held' AND id IN (${ph})`,
          [holdId, ...seatIds]
        );
        if (Number(owned.rows[0].count) !== seatIds.length) {
          await db.query('ROLLBACK');
          return { status: 409, body: { error: 'Hold does not own all requested seats' } };
        }
        const booked = await db.query(
          `UPDATE seats
              SET status = 'booked', booked_by = $1, hold_expires_at = NULL
            WHERE hold_id = $2 AND status = 'held'
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [hold.session_id, holdId]
        );
        if (booked.rows.length !== seatIds.length) {
          await db.query('ROLLBACK');
          return { status: 409, body: { error: 'Could not book every seat in the hold' } };
        }
        const confirmed = await db.query(
          `UPDATE holds SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()) WHERE id = $1 RETURNING *`,
          [holdId]
        );
        await db.query('COMMIT');
        return {
          status: 200,
          body: { hold: publicHold(confirmed.rows[0]), seats: booked.rows.map(publicSeat) },
          broadcasts: [
            ...(released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : []),
            { type: 'booked', holdId, seats: booked.rows.map(publicSeat) }
          ]
        };
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
    if (result.broadcasts) result.broadcasts.forEach(broadcast);
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = req.body?.sessionId || req.query?.sessionId ? String(req.body?.sessionId || req.query?.sessionId).trim() : null;
    const result = await enqueue(async () => {
      await db.query('BEGIN');
      try {
        const holdRes = await db.query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [holdId]);
        if (!holdRes.rows.length) {
          await db.query('ROLLBACK');
          return { status: 404, body: { error: 'Unknown hold' } };
        }
        const hold = holdRes.rows[0];
        if (sessionId && sessionId !== hold.session_id) {
          await db.query('ROLLBACK');
          return { status: 403, body: { error: 'Hold belongs to a different session' } };
        }
        if (hold.status !== 'active') {
          await db.query('COMMIT');
          return { status: 200, body: { hold: publicHold(hold), seats: [], noop: true } };
        }
        const released = await db.query(
          `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL
            WHERE hold_id = $1 AND status = 'held'
            RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by`,
          [holdId]
        );
        const updatedHold = await db.query(
          `UPDATE holds SET status = 'released', released_at = COALESCE(released_at, now()) WHERE id = $1 RETURNING *`,
          [holdId]
        );
        await db.query('COMMIT');
        return { status: 200, body: { hold: publicHold(updatedHold.rows[0]), seats: released.rows.map(publicSeat) }, broadcasts: released.rows.length ? [{ type: 'released', seats: released.rows.map(publicSeat) }] : [] };
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
    if (result.broadcasts) result.broadcasts.forEach(broadcast);
    res.status(result.status).json(result.body);
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
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error) });
});

await initDb();
setInterval(() => sweepExpiredHolds().catch((error) => console.error('expiry sweep failed', error)), 1000).unref();
setInterval(() => {
  for (const res of sseClients) res.write(': keep-alive\n\n');
}, 15000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking backend listening on http://localhost:${PORT}`);
});
