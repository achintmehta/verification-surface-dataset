import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ---- helpers ---------------------------------------------------------------

function parseISO(value) {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function serialize(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

/**
 * Validate an event payload.
 * Returns { ok: true, value } or { ok: false, error }.
 */
function validateEvent(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length === 0) {
    return { ok: false, error: 'Title must be a non-empty string' };
  }
  const start = parseISO(body.start_at);
  const end = parseISO(body.end_at);
  if (!start) return { ok: false, error: 'start_at must be a valid ISO date-time' };
  if (!end) return { ok: false, error: 'end_at must be a valid ISO date-time' };
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return { ok: true, value: { title, start_at: start.toISOString(), end_at: end.toISOString() } };
}

// ---- routes ----------------------------------------------------------------

// GET /api/events?start=<iso>&end=<iso>
// Returns events that overlap the [start, end) range.
app.get('/api/events', async (req, res) => {
  const start = parseISO(req.query.start);
  const end = parseISO(req.query.end);
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO date-times' });
  }
  try {
    const db = await getDb();
    // overlap: event.start < range.end AND event.end > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, end_at ASC`,
      [end.toISOString(), start.toISOString()]
    );
    res.json(result.rows.map(serialize));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const validation = validateEvent(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  const { title, start_at, end_at } = validation.value;
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(serialize(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const validation = validateEvent(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  const { title, start_at, end_at } = validation.value;
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(serialize(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
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
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });

export default app;
