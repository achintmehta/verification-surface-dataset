import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function serialize(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

// Validate event payload. Returns { ok, error, values }
function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body required' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { ok: false, error: 'Title must be non-empty' };
  }
  if (!isValidDate(body.start_at) || !isValidDate(body.end_at)) {
    return { ok: false, error: 'start_at and end_at must be valid ISO timestamps' };
  }
  const start = new Date(body.start_at);
  const end = new Date(body.end_at);
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return { ok: true, values: { title, start: start.toISOString(), end: end.toISOString() } };
}

// GET /api/events?start=<iso>&end=<iso> -> events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end)) {
      return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
    }
    const db = await getDb();
    // Overlap: event.start_at < end AND event.end_at > start
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1 AND end_at > $2
        ORDER BY start_at ASC, id ASC`,
      [new Date(end).toISOString(), new Date(start).toISOString()]
    );
    res.json(result.rows.map(serialize));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const v = validatePayload(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [v.values.title, v.values.start, v.values.end]
    );
    res.status(201).json(serialize(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const v = validatePayload(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [v.values.title, v.values.start, v.values.end, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(serialize(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar server listening on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
