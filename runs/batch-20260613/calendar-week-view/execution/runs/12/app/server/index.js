import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

function serializeEvent(row) {
  return {
    id: String(row.id),
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate an ISO date string; return Date or null.
function parseDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Validate body for create/update. Returns { error } or { title, start, end }.
function validateEventBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  const { title, start_at, end_at } = body;
  if (typeof title !== 'string' || title.trim() === '') {
    return { error: 'Title must be a non-empty string' };
  }
  const start = parseDate(start_at);
  if (!start) return { error: 'start_at must be a valid ISO timestamp' };
  const end = parseDate(end_at);
  if (!end) return { error: 'end_at must be a valid ISO timestamp' };
  if (end.getTime() <= start.getTime()) {
    return { error: 'end_at must be after start_at' };
  }
  return { title: title.trim(), start, end };
}

// GET /api/events?start=<iso>&end=<iso> -> events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  try {
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    if (!start || !end) {
      return res
        .status(400)
        .json({ error: 'start and end query params must be valid ISO timestamps' });
    }
    const db = await getDb();
    // Overlap condition: start_at < range_end AND end_at > range_start
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, end_at ASC`,
      [end.toISOString(), start.toISOString()]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const parsed = validateEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.start.toISOString(), parsed.end.toISOString()]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const parsed = validateEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
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
    console.error('PUT /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve built frontend in production if it exists.
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });

export { app, validateEventBody };
