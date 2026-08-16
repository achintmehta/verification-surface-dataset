import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 1000);

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, '..', 'pglite-data'));

const sseClients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: row.status,
    holdId: row.hold_id,
    holdExpiresAt: row.hold_expires_at,
    bookedBy: row.booked_by,
    holderSessionId: row.holder_session_id,
  };
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...sseClients]) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      holder_session_id TEXT,
      booked_at TIMESTAMPTZ,
      UNIQUE(row_label, seat_number),
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_expires_at IS NULL AND booked_by IS NULL AND holder_session_id IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booked_by IS NULL AND holder_session_id IS NOT NULL)
        OR (status = 'booked' AND hold_id IS NOT NULL AND booked_by IS NOT NULL)
      )
    );
  `);
  await query(`ALTER TABLE seats ADD COLUMN IF NOT EXISTS holder_session_id TEXT;`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS seats_status_idx ON seats(status);`);
  await query(`CREATE INDEX IF NOT EXISTS seats_hold_idx ON seats(hold_id);`);

  const count = await query(`SELECT COUNT(*)::int AS count FROM seats;`);
  if (Number(count.rows[0].count) === 0) {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        await query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available');`,
          [`${row}${n}`, row, n]
        );
      }
    }
  }
}

async function sweepExpiredHolds({ broadcastChanges = true } = {}) {
  return enqueueWrite(async () => {
    await query('BEGIN');
    try {
      const expired = await query(
        `SELECT id, hold_id FROM seats WHERE status = 'held' AND hold_expires_at <= NOW() ORDER BY id;`
      );
      if (expired.rows.length === 0) {
        await query('COMMIT');
        return [];
      }
      const ids = expired.rows.map((r) => r.id);
      await query(
        `UPDATE seats
           SET status = 'available', hold_id = NULL, hold_expires_at = NULL, holder_session_id = NULL
         WHERE id = ANY($1::text[]) AND status = 'held' AND hold_expires_at <= NOW();`,
        [ids]
      );
      await query('COMMIT');
      const seats = ids.map((id) => ({ id, status: 'available', holdId: null, holdExpiresAt: null, bookedBy: null }));
      if (broadcastChanges) broadcast('seats', { type: 'expired', seats });
      return seats;
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function getSeats() {
  await sweepExpiredHolds();
  const result = await query(
    `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, holder_session_id
       FROM seats
      ORDER BY row_label, seat_number;`
  );
  return result.rows.map(normalizeSeat);
}

function validateSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) return null;
  const unique = [...new Set(seatIds.map(String))];
  if (unique.length !== seatIds.length) return null;
  if (unique.length > ROWS.length * SEATS_PER_ROW) return null;
  return unique;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/seats', async (_req, res, next) => {
  try {
    const seats = await getSeats();
    const inventory = seats.reduce(
      (acc, seat) => {
        acc[seat.status]++;
        acc.total++;
        return acc;
      },
      { available: 0, held: 0, booked: 0, total: 0 }
    );
    res.json({ seats, inventory, holdTtlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', async (req, res, next) => {
  const seatIds = validateSeatIds(req.body?.seatIds);
  const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim() ? req.body.sessionId.trim() : null;
  if (!seatIds || !sessionId) return res.status(400).json({ error: 'seatIds (unique non-empty array) and sessionId are required' });

  try {
    await sweepExpiredHolds();
    const result = await enqueueWrite(async () => {
      const holdId = crypto.randomUUID();
      await query('BEGIN');
      try {
        const selected = await query(
          `SELECT id, status FROM seats WHERE id = ANY($1::text[]) ORDER BY id;`,
          [seatIds]
        );
        const found = new Set(selected.rows.map((r) => r.id));
        const conflicts = seatIds.filter((id) => !found.has(id));
        conflicts.push(...selected.rows.filter((r) => r.status !== 'available').map((r) => r.id));
        if (conflicts.length > 0 || selected.rows.length !== seatIds.length) {
          await query('ROLLBACK');
          return { ok: false, conflicts: [...new Set(conflicts)] };
        }

        const updated = await query(
          `UPDATE seats
              SET status = 'held', hold_id = $1, hold_expires_at = NOW() + ($2::text)::interval, holder_session_id = $4
            WHERE id = ANY($3::text[]) AND status = 'available'
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, holder_session_id;`,
          [holdId, `${HOLD_TTL_MS} milliseconds`, seatIds, sessionId]
        );
        if (updated.rows.length !== seatIds.length) {
          const latest = await query(`SELECT id FROM seats WHERE id = ANY($1::text[]) AND status <> 'available';`, [seatIds]);
          await query('ROLLBACK');
          return { ok: false, conflicts: latest.rows.map((r) => r.id) };
        }
        await query('COMMIT');
        return { ok: true, holdId, seats: updated.rows.map(normalizeSeat) };
      } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
      }
    });

    if (!result.ok) return res.status(409).json({ error: 'One or more seats are unavailable', conflictingSeatIds: result.conflicts });
    const expiresAt = result.seats[0]?.holdExpiresAt;
    broadcast('seats', { type: 'held', holdId: result.holdId, seats: result.seats });
    res.status(201).json({ hold: { id: result.holdId, sessionId, seatIds, expiresAt }, seats: result.seats, ttlMs: HOLD_TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  const holdId = req.params.holdId;
  const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim() ? req.body.sessionId.trim() : null;
  if (!holdId || !sessionId) return res.status(400).json({ error: 'holdId and sessionId are required' });

  try {
    await sweepExpiredHolds();
    const result = await enqueueWrite(async () => {
      await query('BEGIN');
      try {
        const rows = await query(
          `SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, holder_session_id
             FROM seats WHERE hold_id = $1 ORDER BY id;`,
          [holdId]
        );
        if (rows.rows.length === 0) {
          await query('ROLLBACK');
          return { ok: false, status: 404, error: 'Unknown hold' };
        }

        const booked = rows.rows.filter((r) => r.status === 'booked');
        if (booked.length === rows.rows.length) {
          const ownerMismatch = booked.some((r) => r.booked_by !== sessionId);
          await query('COMMIT');
          if (ownerMismatch) return { ok: false, status: 403, error: 'Hold belongs to another session' };
          return { ok: true, idempotent: true, seats: rows.rows.map(normalizeSeat) };
        }

        const wrongSession = rows.rows.some((r) => r.holder_session_id !== sessionId);
        if (wrongSession) {
          await query('ROLLBACK');
          return { ok: false, status: 403, error: 'Hold belongs to another session' };
        }

        const invalid = rows.rows.some((r) => r.status !== 'held' || !r.hold_expires_at || new Date(r.hold_expires_at).getTime() <= Date.now());
        if (invalid) {
          // Release expired seats belonging to this hold; do not book anything.
          await query(
            `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL, holder_session_id=NULL
              WHERE hold_id=$1 AND status='held' AND hold_expires_at <= NOW();`,
            [holdId]
          );
          await query('COMMIT');
          return { ok: false, status: 410, error: 'Hold expired or is no longer active' };
        }

        const updated = await query(
          `UPDATE seats
              SET status = 'booked', booked_by = $2, booked_at = NOW()
            WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW() AND holder_session_id = $2
          RETURNING id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by, holder_session_id;`,
          [holdId, sessionId]
        );
        if (updated.rows.length !== rows.rows.length) {
          await query('ROLLBACK');
          return { ok: false, status: 409, error: 'Hold could not be confirmed atomically' };
        }
        await query('COMMIT');
        return { ok: true, idempotent: false, seats: updated.rows.map(normalizeSeat) };
      } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
      }
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    broadcast('seats', { type: result.idempotent ? 'booking-confirmed' : 'booked', holdId, seats: result.seats });
    res.json({ booking: { holdId, sessionId, seatIds: result.seats.map((s) => s.id) }, seats: result.seats, idempotent: result.idempotent });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  const holdId = req.params.holdId;
  try {
    const result = await enqueueWrite(async () => {
      await query('BEGIN');
      try {
        const releasedRows = await query(
          `UPDATE seats
              SET status = 'available', hold_id = NULL, hold_expires_at = NULL, holder_session_id = NULL
            WHERE hold_id = $1 AND status = 'held'
          RETURNING id;`,
          [holdId]
        );
        await query('COMMIT');
        return releasedRows.rows.map((r) => ({ id: r.id, status: 'available', holdId: null, holdExpiresAt: null, bookedBy: null }));
      } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
    if (result.length) broadcast('seats', { type: 'released', holdId, seats: result });
    res.json({ releasedSeatIds: result.map((s) => s.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

setInterval(() => {
  sweepExpiredHolds().catch((err) => console.error('expiry sweep failed', err));
}, SWEEP_INTERVAL_MS).unref();

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(err.message || err) });
});

await initDb();
app.listen(PORT, () => console.log(`Seat booking server listening on http://localhost:${PORT}`));
