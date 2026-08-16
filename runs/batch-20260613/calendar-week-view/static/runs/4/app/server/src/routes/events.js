/**
 * Events router – all /api/events endpoints.
 */

import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

/* ------------------------------------------------------------------ helpers */

/**
 * Parse and validate an ISO date string.
 * Returns a Date on success, null on failure.
 * @param {string} value
 * @returns {Date|null}
 */
function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a JS Date to a Postgres-compatible ISO timestamp string.
 * @param {Date} d
 * @returns {string}
 */
function toTs(d) {
  return d.toISOString();
}

/**
 * Validate the body fields common to POST and PUT.
 * Returns { error } on failure or { title, startAt, endAt } on success.
 */
function validateEventBody(body) {
  const { title, start_at, end_at } = body ?? {};

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return { error: 'title must be a non-empty string' };
  }

  const startAt = parseDate(start_at);
  if (!startAt) {
    return { error: 'start_at must be a valid ISO date-time string' };
  }

  const endAt = parseDate(end_at);
  if (!endAt) {
    return { error: 'end_at must be a valid ISO date-time string' };
  }

  if (endAt <= startAt) {
    return { error: 'end_at must be strictly after start_at' };
  }

  return { title: title.trim(), startAt, endAt };
}

/* ------------------------------------------------------------------ routes */

/**
 * GET /api/events?start=<iso>&end=<iso>
 * Returns all events whose time range overlaps [start, end).
 * An event overlaps the range when: event.start_at < range.end AND event.end_at > range.start
 */
router.get('/', async (req, res) => {
  const rangeStart = parseDate(req.query.start);
  const rangeEnd   = parseDate(req.query.end);

  if (!rangeStart || !rangeEnd) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO date-time strings' });
  }

  if (rangeEnd <= rangeStart) {
    return res.status(400).json({ error: 'end must be after start' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1
          AND end_at   > $2
        ORDER BY start_at, id`,
      [toTs(rangeEnd), toTs(rangeStart)]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/events
 * Body: { title, start_at, end_at }
 * Creates a new event; returns 201 with the created row.
 */
router.post('/', async (req, res) => {
  const validated = validateEventBody(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  const { title, startAt, endAt } = validated;

  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, toTs(startAt), toTs(endAt)]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/events error:', err);
    // Surface constraint violations as 400.
    if (err.message && err.message.includes('check')) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/events/:id
 * Body: { title, start_at, end_at }
 * Updates an existing event; returns the updated row or 404.
 */
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  const validated = validateEventBody(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  const { title, startAt, endAt } = validated;

  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events
          SET title    = $1,
              start_at = $2,
              end_at   = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [title, toTs(startAt), toTs(endAt), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    if (err.message && err.message.includes('check')) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/events/:id
 * Deletes an event; returns 204 on success or 404 if not found.
 */
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    return res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
