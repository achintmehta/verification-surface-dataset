import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let db;

async function initDb() {
  db = new PGlite('./pgdata');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CHECK (end_at > start_at)
    );
  `);
  console.log('Database initialized');
}

await initDb();

function validateEvent(title, start_at, end_at) {
  if (!title || title.trim() === '') {
    return 'Title is required';
  }
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return 'Invalid date format';
  }
  if (end <= start) {
    return 'End time must be after start time';
  }
  return null;
}

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }
  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events 
       WHERE start_at < $1 AND end_at > $2 
       ORDER BY start_at`,
      [end, start]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;
  const error = validateEvent(title, start_at, end_at);
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) 
       VALUES ($1, $2, $3) RETURNING id, title, start_at, end_at`,
      [title.trim(), start_at, end_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, start_at, end_at } = req.body;
  const error = validateEvent(title, start_at, end_at);
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 
       WHERE id = $4 RETURNING id, title, start_at, end_at`,
      [title.trim(), start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});