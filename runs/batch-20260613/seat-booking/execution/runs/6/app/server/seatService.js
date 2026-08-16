import crypto from 'node:crypto';
import { db, HOLD_TTL_SECONDS, normalizeSeat } from './database.js';

let writeQueue = Promise.resolve();

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

async function transaction(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      // ignore rollback failure and rethrow original error
    }
    throw error;
  }
}

export function createSeatBroadcaster() {
  const clients = new Set();

  function send(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  return {
    add(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    broadcast(event, data) {
      for (const res of clients) {
        try {
          send(res, event, data);
        } catch {
          clients.delete(res);
        }
      }
    },
    heartbeat() {
      for (const res of clients) {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clients.delete(res);
        }
      }
    },
  };
}

export function seatChangePayload(seats, action) {
  return {
    action,
    seats: seats.map(normalizeSeat),
    inventory: null,
    at: new Date().toISOString(),
  };
}

async function inventoryUnsafe() {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'held')::int AS held,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM seats
  `);
  const row = result.rows[0];
  return {
    total: Number(row.total),
    available: Number(row.available),
    held: Number(row.held),
    booked: Number(row.booked),
  };
}

export async function getInventory() {
  await sweepExpiredHolds();
  return inventoryUnsafe();
}

export async function sweepExpiredHolds(broadcaster = null) {
  return withWriteLock(async () => transaction(async () => {
    const expired = await db.query(`
      SELECT * FROM seats
      WHERE status = 'held' AND hold_expires_at <= NOW()
      ORDER BY row_label, seat_number
    `);

    if (expired.rows.length === 0) {
      return [];
    }

    const ids = expired.rows.map((row) => row.id);
    await db.query(
      `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_session_id = NULL,
           hold_expires_at = NULL
       WHERE id = ANY($1)`,
      [ids],
    );

    const released = await db.query(
      'SELECT * FROM seats WHERE id = ANY($1) ORDER BY row_label, seat_number',
      [ids],
    );
    const payload = seatChangePayload(released.rows, 'released');
    payload.inventory = await inventoryUnsafe();
    broadcaster?.broadcast('seats', payload);
    return released.rows.map(normalizeSeat);
  }));
}

export async function listSeats(broadcaster = null) {
  await sweepExpiredHolds(broadcaster);
  const result = await db.query(
    'SELECT * FROM seats ORDER BY row_label, seat_number',
  );
  return {
    seats: result.rows.map(normalizeSeat),
    inventory: await inventoryUnsafe(),
    holdTtlSeconds: HOLD_TTL_SECONDS,
  };
}

function validateSeatIds(seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    const err = new Error('seatIds must be a non-empty array');
    err.status = 400;
    throw err;
  }
  const unique = [...new Set(seatIds.map(String))];
  if (unique.length !== seatIds.length) {
    const err = new Error('seatIds must not contain duplicates');
    err.status = 400;
    throw err;
  }
  if (unique.length > 20) {
    const err = new Error('Cannot hold more than 20 seats at once');
    err.status = 400;
    throw err;
  }
  return unique;
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim().length < 1 || sessionId.length > 128) {
    const err = new Error('sessionId is required');
    err.status = 400;
    throw err;
  }
  return sessionId.trim();
}

export async function createHold({ seatIds, sessionId }, broadcaster = null) {
  const ids = validateSeatIds(seatIds);
  const holder = validateSessionId(sessionId);
  await sweepExpiredHolds(broadcaster);

  return withWriteLock(async () => transaction(async () => {
    const selected = await db.query(
      'SELECT * FROM seats WHERE id = ANY($1) ORDER BY row_label, seat_number',
      [ids],
    );
    const foundIds = new Set(selected.rows.map((row) => row.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    const unavailable = selected.rows.filter((row) => row.status !== 'available').map((row) => row.id);
    const conflicts = [...missingIds, ...unavailable];

    if (conflicts.length > 0 || selected.rows.length !== ids.length) {
      const err = new Error('One or more seats are unavailable');
      err.status = 409;
      err.details = { conflictingSeatIds: conflicts };
      throw err;
    }

    const holdId = crypto.randomUUID();
    const expiresResult = await db.query(
      `UPDATE seats
       SET status = 'held',
           hold_id = $1,
           hold_session_id = $2,
           hold_expires_at = NOW() + ($3 || ' seconds')::INTERVAL
       WHERE id = ANY($4) AND status = 'available'
       RETURNING *`,
      [holdId, holder, HOLD_TTL_SECONDS, ids],
    );

    if (expiresResult.rows.length !== ids.length) {
      throw Object.assign(new Error('Concurrent seat acquisition failed'), { status: 409, details: { conflictingSeatIds: ids } });
    }

    const seats = expiresResult.rows.sort((a, b) => a.row_label.localeCompare(b.row_label) || a.seat_number - b.seat_number);
    const inventory = await inventoryUnsafe();
    broadcaster?.broadcast('seats', {
      action: 'held',
      seats: seats.map(normalizeSeat),
      inventory,
      at: new Date().toISOString(),
    });

    return {
      holdId,
      sessionId: holder,
      expiresAt: new Date(seats[0].hold_expires_at).toISOString(),
      ttlSeconds: HOLD_TTL_SECONDS,
      seats: seats.map(normalizeSeat),
      inventory,
    };
  }));
}

export async function confirmHold(holdId, sessionId, broadcaster = null) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.status = 400;
    throw err;
  }
  const holder = validateSessionId(sessionId);
  await sweepExpiredHolds(broadcaster);

  return withWriteLock(async () => transaction(async () => {
    const alreadyBooked = await db.query(
      `SELECT * FROM seats
       WHERE booked_hold_id = $1 AND booked_by = $2 AND status = 'booked'
       ORDER BY row_label, seat_number`,
      [holdId, holder],
    );

    if (alreadyBooked.rows.length > 0) {
      return {
        holdId,
        sessionId: holder,
        status: 'booked',
        idempotent: true,
        seats: alreadyBooked.rows.map(normalizeSeat),
        inventory: await inventoryUnsafe(),
      };
    }

    const held = await db.query(
      `SELECT * FROM seats
       WHERE hold_id = $1 AND hold_session_id = $2 AND status = 'held'
       ORDER BY row_label, seat_number`,
      [holdId, holder],
    );

    if (held.rows.length === 0) {
      const err = new Error('Unknown, expired, or non-owned hold');
      err.status = 404;
      throw err;
    }

    const expired = held.rows.some((row) => new Date(row.hold_expires_at).getTime() <= Date.now());
    if (expired) {
      const err = new Error('Hold has expired');
      err.status = 409;
      throw err;
    }

    const booked = await db.query(
      `UPDATE seats
       SET status = 'booked',
           booked_by = hold_session_id,
           booked_hold_id = hold_id,
           booked_at = NOW(),
           hold_id = NULL,
           hold_session_id = NULL,
           hold_expires_at = NULL
       WHERE hold_id = $1 AND hold_session_id = $2 AND status = 'held' AND hold_expires_at > NOW()
       RETURNING *`,
      [holdId, holder],
    );

    if (booked.rows.length !== held.rows.length) {
      const err = new Error('Hold could not be confirmed');
      err.status = 409;
      throw err;
    }

    const seats = booked.rows.sort((a, b) => a.row_label.localeCompare(b.row_label) || a.seat_number - b.seat_number);
    const inventory = await inventoryUnsafe();
    broadcaster?.broadcast('seats', {
      action: 'booked',
      seats: seats.map(normalizeSeat),
      inventory,
      at: new Date().toISOString(),
    });

    return {
      holdId,
      sessionId: holder,
      status: 'booked',
      idempotent: false,
      seats: seats.map(normalizeSeat),
      inventory,
    };
  }));
}

export async function releaseHold(holdId, sessionId, broadcaster = null) {
  if (!holdId) {
    const err = new Error('holdId is required');
    err.status = 400;
    throw err;
  }
  const holder = sessionId ? validateSessionId(sessionId) : null;
  await sweepExpiredHolds(broadcaster);

  return withWriteLock(async () => transaction(async () => {
    const params = holder ? [holdId, holder] : [holdId];
    const where = holder ? 'hold_id = $1 AND hold_session_id = $2' : 'hold_id = $1';
    const held = await db.query(`SELECT * FROM seats WHERE ${where} AND status = 'held'`, params);
    if (held.rows.length === 0) {
      return { holdId, released: false, seats: [], inventory: await inventoryUnsafe() };
    }

    await db.query(
      `UPDATE seats
       SET status = 'available',
           hold_id = NULL,
           hold_session_id = NULL,
           hold_expires_at = NULL
       WHERE ${where} AND status = 'held'`,
      params,
    );
    const ids = held.rows.map((row) => row.id);
    const released = await db.query('SELECT * FROM seats WHERE id = ANY($1) ORDER BY row_label, seat_number', [ids]);
    const inventory = await inventoryUnsafe();
    broadcaster?.broadcast('seats', {
      action: 'released',
      seats: released.rows.map(normalizeSeat),
      inventory,
      at: new Date().toISOString(),
    });

    return { holdId, released: true, seats: released.rows.map(normalizeSeat), inventory };
  }));
}
