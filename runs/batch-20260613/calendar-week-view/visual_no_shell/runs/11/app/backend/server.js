import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Validate an ISO timestamp string -> Date or null
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate event payload. Returns { error } or { title, start, end }
function validateEventPayload(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { error: 'Title must be a non-empty string' };
  }
  const start = parseDate(body.start_at);
  if (!start) {
    return { error: 'start_at must be a valid ISO timestamp' };
  }
  const end = parseDate(body.end_at);
  if (!end) {
    return { error: 'end_at must be a valid ISO timestamp' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { error: 'end_at must be after start_at' };
  }
  return { title, start, end };
}

// GET events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end);
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
  }
  try {
    const db = await getDb();
    // overlap: event.start_at < range.end AND event.end_at > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, id ASC`,
      [end.toISOString(), start.toISOString()]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/events', async (req, res) => {
  const parsed = validateEventPayload(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.start.toISOString(), parsed.end.toISOString()]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const parsed = validateEventPayload(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.start.toISOString(), parsed.end.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
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
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
