import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate and normalize a payload. Returns { ok, value, error }.
function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { ok: false, error: 'Title must be a non-empty string.' };
  }
  const start = new Date(body.start_at);
  const end = new Date(body.end_at);
  if (isNaN(start.getTime())) {
    return { ok: false, error: 'start_at must be a valid date.' };
  }
  if (isNaN(end.getTime())) {
    return { ok: false, error: 'end_at must be a valid date.' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at.' };
  }
  return {
    ok: true,
    value: { title, start_at: start.toISOString(), end_at: end.toISOString() },
  };
}

// GET /api/events?start=<iso>&end=<iso>  -> events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = await getDb();
    let result;
    if (start && end) {
      const s = new Date(start);
      const e = new Date(end);
      if (isNaN(s.getTime()) || isNaN(e.getTime())) {
        return res.status(400).json({ error: 'Invalid start or end query param.' });
      }
      // Overlap: event.start < range.end AND event.end > range.start
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         WHERE start_at < $1 AND end_at > $2
         ORDER BY start_at ASC`,
        [e.toISOString(), s.toISOString()]
      );
    } else {
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events ORDER BY start_at ASC`
      );
    }
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [v.value.title, v.value.start_at, v.value.end_at]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id.' });
  }
  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [v.value.title, v.value.start_at, v.value.end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
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
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar API listening on http://localhost:${PORT}`);
  });
});
