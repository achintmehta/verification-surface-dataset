import { getDb } from './db.js';

function toEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

/**
 * Validate raw event input.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function validateEventInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const { title, start_at, end_at } = body;

  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  if (typeof start_at !== 'string' || typeof end_at !== 'string') {
    return { ok: false, error: 'start_at and end_at must be ISO date strings' };
  }
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'start_at and end_at must be valid dates' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return {
    ok: true,
    value: {
      title: title.trim(),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
}

/** Events overlapping [start, end): start_at < end AND end_at > start. */
export async function listEvents(start, end) {
  const db = await getDb();
  const res = await db.query(
    `SELECT id, title, start_at, end_at
       FROM events
      WHERE start_at < $2 AND end_at > $1
      ORDER BY start_at ASC, end_at ASC, id ASC`,
    [start, end]
  );
  return res.rows.map(toEvent);
}

export async function createEvent({ title, start_at, end_at }) {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO events (title, start_at, end_at)
     VALUES ($1, $2, $3)
     RETURNING id, title, start_at, end_at`,
    [title, start_at, end_at]
  );
  return toEvent(res.rows[0]);
}

export async function updateEvent(id, { title, start_at, end_at }) {
  const db = await getDb();
  const res = await db.query(
    `UPDATE events
        SET title = $1, start_at = $2, end_at = $3
      WHERE id = $4
      RETURNING id, title, start_at, end_at`,
    [title, start_at, end_at, id]
  );
  if (res.rows.length === 0) return null;
  return toEvent(res.rows[0]);
}

export async function deleteEvent(id) {
  const db = await getDb();
  const res = await db.query(
    `DELETE FROM events WHERE id = $1 RETURNING id`,
    [id]
  );
  return res.rows.length > 0;
}
