import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function isValidIso(str) {
  if (typeof str !== 'string' || !str.trim()) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function toIso(val) {
  if (val instanceof Date) return val.toISOString();
  // PGLite may return timestamps as strings like "2025-06-18T09:00:00.000Z"
  // or "2025-06-18 09:00:00+00" — normalise to ISO 8601.
  const d = new Date(val);
  if (!isNaN(d.getTime())) return d.toISOString();
  // Last resort: try replacing space separator
  const d2 = new Date(String(val).replace(' ', 'T'));
  return d2.toISOString();
}

function toRow(row) {
  return {
    id:       row.id,
    title:    row.title,
    start_at: toIso(row.start_at),
    end_at:   toIso(row.end_at),
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/events?start=<iso>&end=<iso>                               */
/* ------------------------------------------------------------------ */

router.get('/', async (req, res) => {
  const { start, end } = req.query;

  if (!isValidIso(start) || !isValidIso(end)) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
  }

  try {
    const db = await getDb();
    // Return events that overlap the requested range:
    //   event.start_at < rangeEnd  AND  event.end_at > rangeStart
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1
          AND end_at   > $2
        ORDER BY start_at`,
      [new Date(end).toISOString(), new Date(start).toISOString()]
    );
    return res.json(result.rows.map(toRow));
  } catch (err) {
    console.error('GET /api/events error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/events                                                     */
/* ------------------------------------------------------------------ */

router.post('/', async (req, res) => {
  const { title, start_at, end_at } = req.body ?? {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!isValidIso(start_at)) {
    return res.status(400).json({ error: 'start_at must be a valid ISO timestamp' });
  }
  if (!isValidIso(end_at)) {
    return res.status(400).json({ error: 'end_at must be a valid ISO timestamp' });
  }

  const startDate = new Date(start_at);
  const endDate   = new Date(end_at);

  if (endDate <= startDate) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title.trim(), startDate.toISOString(), endDate.toISOString()]
    );
    return res.status(201).json(toRow(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/* PUT /api/events/:id                                                  */
/* ------------------------------------------------------------------ */

router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }

  const { title, start_at, end_at } = req.body ?? {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!isValidIso(start_at)) {
    return res.status(400).json({ error: 'start_at must be a valid ISO timestamp' });
  }
  if (!isValidIso(end_at)) {
    return res.status(400).json({ error: 'end_at must be a valid ISO timestamp' });
  }

  const startDate = new Date(start_at);
  const endDate   = new Date(end_at);

  if (endDate <= startDate) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events
          SET title    = $1,
              start_at = $2,
              end_at   = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [title.trim(), startDate.toISOString(), endDate.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    return res.json(toRow(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /api/events/:id                                               */
/* ------------------------------------------------------------------ */

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
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
    return res.json({ deleted: true, id });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
