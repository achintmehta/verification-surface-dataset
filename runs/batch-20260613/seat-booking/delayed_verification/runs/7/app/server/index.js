import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 30_000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

const db = new PGlite(process.env.PGLITE_DATA_DIR || './.pglite');
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// PGlite is embedded in-process. A small promise queue gives every multi-statement
// operation a single critical section, so BEGIN/COMMIT blocks cannot interleave.
let dbQueue = Promise.resolve();
async function withDbLock(fn) {
  const previous = dbQueue;
  let release;
  dbQueue = new Promise((resolve) => (release = resolve));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function inTransaction(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function placeholders(values, start = 1) {
  return values.map((_, i) => `$${i + start}`).join(', ');
}

function rowCount(result) {
  return Number(result?.affectedRows ?? result?.rowsAffected ?? result?.rowCount ?? 0);
}

function normalizeSeatIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
}

async function initDb() {
  await withDbLock(async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS seats (
        id TEXT PRIMARY KEY,
        row_label TEXT NOT NULL,
        seat_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
        hold_id TEXT NULL,
        hold_expires_at TEXT NULL,
        booked_by TEXT NULL,
        UNIQUE (row_label, seat_number)
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seat_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
        expires_at TEXT NOT NULL,
        booking_id TEXT NULL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT NULL,
        released_at TEXT NULL
      );
    `);
    const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
    if (Number(count.rows[0].count) === 0) {
      await inTransaction(async (tx) => {
        for (const row of ROWS) {
          for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
            await tx.query(
              'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
              [`${row}-${seatNumber}`, row, seatNumber, 'available']
            );
          }
        }
      });
    }
  });
}

async function inventory(tx = db) {
  const result = await tx.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'held')::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  return result.rows[0];
}

async function seatRows(tx = db, ids = null) {
  if (Array.isArray(ids) && ids.length === 0) return [];
  if (ids && ids.length) {
    const result = await tx.query(
      `SELECT id, row_label AS "row", seat_number AS "seatNumber", status, hold_id AS "holdId", hold_expires_at AS "holdExpiresAt", booked_by AS "bookedBy"
       FROM seats WHERE id IN (${placeholders(ids)}) ORDER BY row_label, seat_number`,
      ids
    );
    return result.rows;
  }
  const result = await tx.query(`
    SELECT id, row_label AS "row", seat_number AS "seatNumber", status, hold_id AS "holdId", hold_expires_at AS "holdExpiresAt", booked_by AS "bookedBy"
    FROM seats
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

async function sweepExpired(tx = db) {
  const ts = nowIso();
  const expiredSeats = await tx.query(
    `SELECT id FROM seats WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= $1`,
    [ts]
  );
  const ids = expiredSeats.rows.map((r) => r.id);
  if (!ids.length) return [];

  await tx.query(
    `UPDATE holds
       SET status = 'expired', released_at = $1
     WHERE status = 'active' AND expires_at <= $1`,
    [ts]
  );
  await tx.query(
    `UPDATE seats
       SET status = 'available', hold_id = NULL, hold_expires_at = NULL
     WHERE id IN (${placeholders(ids)})`,
    ids
  );
  const rows = await seatRows(tx, ids);
  return rows.map((seat) => ({ type: 'released', seat }));
}

const sseClients = new Set();
function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
async function broadcast(changes) {
  if (!changes || !changes.length || !sseClients.size) return;
  const changedSeatIds = changes.map((change) => change.seat?.id).filter(Boolean);
  let counts = null;
  let freshSeats = [];
  try {
    const uniqueSeatIds = [...new Set(changedSeatIds)];
    const snapshot = await withDbLock(async () => ({ counts: await inventory(db), seats: await seatRows(db, uniqueSeatIds) }));
    counts = snapshot.counts;
    freshSeats = snapshot.seats;
  } catch {
    counts = null;
  }
  if (freshSeats.length) {
    const byId = new Map(freshSeats.map((seat) => [seat.id, seat]));
    changes = changes.map((change) => ({ ...change, seat: byId.get(change.seat.id) || change.seat }));
  }
  const payload = { changes, inventory: counts, at: nowIso() };
  for (const client of sseClients) sendSse(client, 'seat-update', payload);
}

async function lockedSweepAndBroadcast() {
  const result = await withDbLock(() => inTransaction(async (tx) => sweepExpired(tx)));
  await broadcast(result);
  return result;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/seats', async (_req, res, next) => {
  try {
    const { seats, counts, changes } = await withDbLock(() =>
      inTransaction(async (tx) => {
        const changes = await sweepExpired(tx);
        return { seats: await seatRows(tx), counts: await inventory(tx), changes };
      })
    );
    await broadcast(changes);
    res.json({ seats, inventory: counts, holdTtlMs: HOLD_TTL_MS });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const seatIds = normalizeSeatIds(req.body?.seatIds);
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!seatIds.length) return res.status(400).json({ error: 'seatIds must contain at least one seat id' });

    const outcome = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiryChanges = await sweepExpired(tx);
        const selected = await tx.query(
          `SELECT id, status FROM seats WHERE id IN (${placeholders(seatIds)}) ORDER BY id`,
          seatIds
        );
        const found = new Set(selected.rows.map((r) => r.id));
        const conflicts = [
          ...seatIds.filter((id) => !found.has(id)),
          ...selected.rows.filter((r) => r.status !== 'available').map((r) => r.id)
        ];

        if (conflicts.length) {
          return { ok: false, status: 409, conflicts, changes: expiryChanges };
        }

        const holdId = randomUUID();
        const createdAt = nowIso();
        const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
        await tx.query(
          `INSERT INTO holds (id, session_id, seat_count, status, expires_at, created_at)
           VALUES ($1, $2, $3, 'active', $4, $5)`,
          [holdId, sessionId, seatIds.length, expiresAt, createdAt]
        );
        const updateResult = await tx.query(
          `UPDATE seats
             SET status = 'held', hold_id = $1, hold_expires_at = $2, booked_by = NULL
           WHERE id IN (${placeholders(seatIds, 3)}) AND status = 'available'`,
          [holdId, expiresAt, ...seatIds]
        );
        if (rowCount(updateResult) && rowCount(updateResult) !== seatIds.length) {
          throw new Error('Atomic hold acquisition failed');
        }
        const heldSeats = await seatRows(tx, seatIds);
        if (heldSeats.length !== seatIds.length || heldSeats.some((seat) => seat.status !== 'held' || seat.holdId !== holdId)) {
          throw new Error('Atomic hold acquisition verification failed');
        }
        const changes = [
          ...expiryChanges,
          ...heldSeats.map((seat) => ({ type: 'held', seat }))
        ];
        return {
          ok: true,
          changes,
          hold: { id: holdId, sessionId, seatIds, expiresAt, ttlMs: HOLD_TTL_MS, status: 'active' },
          seats: heldSeats,
          counts: await inventory(tx)
        };
      })
    );

    await broadcast(outcome.changes);
    if (!outcome.ok) return res.status(outcome.status).json({ error: 'One or more seats are unavailable', conflictingSeatIds: outcome.conflicts });
    res.status(201).json({ hold: outcome.hold, seats: outcome.seats, inventory: outcome.counts });
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!holdId) return res.status(400).json({ error: 'holdId is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const outcome = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiryChanges = await sweepExpired(tx);
        const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (!holdResult.rows.length) return { ok: false, status: 404, error: 'Unknown hold', changes: expiryChanges };
        const hold = holdResult.rows[0];
        if (hold.session_id !== sessionId) return { ok: false, status: 403, error: 'Hold belongs to another session', changes: expiryChanges };

        if (hold.status === 'confirmed') {
          const seats = await seatRows(tx, (await tx.query('SELECT id FROM seats WHERE hold_id = $1 ORDER BY id', [holdId])).rows.map((r) => r.id));
          return {
            ok: true,
            idempotent: true,
            changes: expiryChanges,
            booking: { id: hold.booking_id, holdId, sessionId: hold.session_id, seatIds: seats.map((s) => s.id), confirmedAt: hold.confirmed_at },
            seats,
            counts: await inventory(tx)
          };
        }

        if (hold.status !== 'active') return { ok: false, status: 410, error: `Hold is ${hold.status}`, changes: expiryChanges };
        if (hold.expires_at <= nowIso()) {
          const heldSeatIds = (await tx.query('SELECT id FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY id', [holdId, 'held'])).rows.map((r) => r.id);
          await tx.query("UPDATE holds SET status = 'expired', released_at = $1 WHERE id = $2 AND status = 'active'", [nowIso(), holdId]);
          if (heldSeatIds.length) {
            await tx.query(
              `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE id IN (${placeholders(heldSeatIds)})`,
              heldSeatIds
            );
          }
          const releasedSeats = await seatRows(tx, heldSeatIds);
          return { ok: false, status: 410, error: 'Hold has expired', changes: [...expiryChanges, ...releasedSeats.map((seat) => ({ type: 'released', seat }))] };
        }

        const owned = await tx.query('SELECT id FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY id', [holdId, 'held']);
        if (owned.rows.length !== Number(hold.seat_count)) {
          return { ok: false, status: 409, error: 'Hold no longer owns all seats', changes: expiryChanges };
        }

        const bookingId = hold.booking_id || randomUUID();
        const confirmedAt = nowIso();
        await tx.query(
          `UPDATE holds SET status = 'confirmed', booking_id = $1, confirmed_at = $2 WHERE id = $3 AND status = 'active'`,
          [bookingId, confirmedAt, holdId]
        );
        await tx.query(
          `UPDATE seats
             SET status = 'booked', hold_expires_at = NULL, booked_by = $1
           WHERE hold_id = $2 AND status = 'held'`,
          [hold.session_id, holdId]
        );
        const seats = await seatRows(tx, owned.rows.map((r) => r.id));
        return {
          ok: true,
          changes: [...expiryChanges, ...seats.map((seat) => ({ type: 'booked', seat }))],
          booking: { id: bookingId, holdId, sessionId: hold.session_id, seatIds: seats.map((s) => s.id), confirmedAt },
          seats,
          counts: await inventory(tx)
        };
      })
    );

    await broadcast(outcome.changes);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ booking: outcome.booking, seats: outcome.seats, inventory: outcome.counts, idempotent: Boolean(outcome.idempotent) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const holdId = String(req.params.holdId || '').trim();
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || '').trim();
    const outcome = await withDbLock(() =>
      inTransaction(async (tx) => {
        const expiryChanges = await sweepExpired(tx);
        const holdResult = await tx.query('SELECT * FROM holds WHERE id = $1', [holdId]);
        if (!holdResult.rows.length) return { ok: false, status: 404, error: 'Unknown hold', changes: expiryChanges };
        const hold = holdResult.rows[0];
        if (sessionId && hold.session_id !== sessionId) return { ok: false, status: 403, error: 'Hold belongs to another session', changes: expiryChanges };
        if (hold.status === 'confirmed') return { ok: false, status: 409, error: 'Confirmed holds cannot be released', changes: expiryChanges };
        if (hold.status !== 'active') return { ok: true, released: false, changes: expiryChanges, seats: [], counts: await inventory(tx) };
        const ids = (await tx.query('SELECT id FROM seats WHERE hold_id = $1 AND status = $2 ORDER BY id', [holdId, 'held'])).rows.map((r) => r.id);
        if (ids.length) {
          await tx.query(
            `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE id IN (${placeholders(ids)})`,
            ids
          );
        }
        await tx.query("UPDATE holds SET status = 'released', released_at = $1 WHERE id = $2", [nowIso(), holdId]);
        const releasedSeats = await seatRows(tx, ids);
        return {
          ok: true,
          released: true,
          changes: [...expiryChanges, ...releasedSeats.map((seat) => ({ type: 'released', seat }))],
          seats: releasedSeats,
          counts: await inventory(tx)
        };
      })
    );
    await broadcast(outcome.changes);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ released: outcome.released, seats: outcome.seats, inventory: outcome.counts });
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
  sendSse(res, 'connected', { at: nowIso() });
  sseClients.add(res);
  const heartbeat = setInterval(() => sendSse(res, 'heartbeat', { at: nowIso() }), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : String(error.message || error) });
});

await initDb();
setInterval(() => lockedSweepAndBroadcast().catch((error) => console.error('expiry sweep failed', error)), 1_000).unref();

app.listen(PORT, () => {
  console.log(`Seat booking backend listening on http://localhost:${PORT}`);
});
