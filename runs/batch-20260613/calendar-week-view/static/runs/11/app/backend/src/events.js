import { getDb } from './db.js';

/**
 * Validate and normalize event input.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function validateEventInput(body) {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length === 0) {
    return { ok: false, error: 'Title must be a non-empty string' };
  }

  const start = parseDate(body.start_at);
  if (!start) {
    return { ok: false, error: 'start_at must be a valid ISO timestamp' };
  }

  const end = parseDate(body.end_at);
  if (!end) {
    return { ok: false, error: 'end_at must be a valid ISO timestamp' };
  }

  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }

  return {
    ok: true,
    value: {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
}

function parseDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

/**
 * Return all events overlapping [start, end).
 * Overlap test: event.start_at < end AND event.end_at > start.
 */
export async function listEventsInRange(startIso, endIso) {
  const db = await getDb();
  const result = await db.query(
    `SELECT id, title, start_at, end_at
       FROM events
      WHERE start_at < $1 AND end_at > $2
      ORDER BY start_at ASC, end_at ASC, id ASC`,
    [endIso, startIso]
  );
  return result.rows.map(rowToEvent);
}

export async function createEvent({ title, start_at, end_at }) {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO events (title, start_at, end_at)
     VALUES ($1, $2, $3)
     RETURNING id, title, start_at, end_at`,
    [title, start_at, end_at]
  );
  return rowToEvent(result.rows[0]);
}

export async function updateEvent(id, { title, start_at, end_at }) {
  const db = await getDb();
  const result = await db.query(
    `UPDATE events
        SET title = $1, start_at = $2, end_at = $3
      WHERE id = $4
      RETURNING id, title, start_at, end_at`,
    [title, start_at, end_at, id]
  );
  if (result.rows.length === 0) return null;
  return rowToEvent(result.rows[0]);
}

export async function deleteEvent(id) {
  const db = await getDb();
  const result = await db.query(
    `DELETE FROM events WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.rows.length > 0;
}
