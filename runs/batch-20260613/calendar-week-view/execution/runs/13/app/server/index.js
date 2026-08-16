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

// Serve built frontend if present (production)
app.use(express.static(path.join(__dirname, '..', 'dist')));

function isValidDate(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

// GET /api/events?start=<iso>&end=<iso>
// Returns all events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'start and end must be valid ISO timestamps' });
  }
  try {
    const db = await getDb();
    // overlap: event.start_at < range.end AND event.end_at > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, id ASC`,
      [new Date(end).toISOString(), new Date(start).toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'invalid body';
  const { title, start_at, end_at } = body;
  if (typeof title !== 'string' || title.trim().length === 0) {
    return 'title must be a non-empty string';
  }
  if (!isValidDate(start_at)) return 'start_at must be a valid ISO timestamp';
  if (!isValidDate(end_at)) return 'end_at must be a valid ISO timestamp';
  if (new Date(end_at).getTime() <= new Date(start_at).getTime()) {
    return 'end_at must be after start_at';
  }
  return null;
}

// POST /api/events
app.post('/api/events', async (req, res) => {
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const db = await getDb();
    const { title, start_at, end_at } = req.body;
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title.trim(), new Date(start_at).toISOString(), new Date(end_at).toISOString()]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const db = await getDb();
    const { title, start_at, end_at } = req.body;
    const result = await db.query(
      `UPDATE events SET title=$1, start_at=$2, end_at=$3 WHERE id=$4
       RETURNING id, title, start_at, end_at`,
      [title.trim(), new Date(start_at).toISOString(), new Date(end_at).toISOString(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rowToEvent(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id=$1 RETURNING id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar backend listening on http://localhost:${PORT}`);
  });
}).catch((e) => {
  console.error('Failed to initialize database', e);
  process.exit(1);
});
