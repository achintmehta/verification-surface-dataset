import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

function serializeEvent(row) {
  return {
    id: String(row.id),
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate and normalize an event payload.
// Returns { ok: true, value } or { ok: false, error }.
function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const { title, start_at, end_at } = body;

  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, error: 'Title must be a non-empty string.' };
  }
  if (typeof start_at !== 'string' || typeof end_at !== 'string') {
    return { ok: false, error: 'start_at and end_at must be ISO date strings.' };
  }
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'start_at and end_at must be valid dates.' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at.' };
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

// GET /api/events?start=<iso>&end=<iso>
// Returns all events overlapping [start, end).
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (typeof start !== 'string' || typeof end !== 'string') {
    return res.status(400).json({ error: 'start and end query params are required.' });
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'start and end must be valid ISO dates.' });
  }
  try {
    const db = await getDb();
    // Overlap condition: event.start < range.end AND event.end > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1 AND end_at > $2
        ORDER BY start_at ASC, end_at ASC, id ASC`,
      [endDate.toISOString(), startDate.toISOString()]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const v = validatePayload(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: v.error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [v.value.title, v.value.start_at, v.value.end_at]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid id.' });
  }
  const v = validatePayload(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: v.error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events
          SET title = $1, start_at = $2, end_at = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [v.value.title, v.value.start_at, v.value.end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid id.' });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Week calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
