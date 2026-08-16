import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize PGLite with local filesystem persistence
const db = new PGlite({ dataDir: './data' });

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    );
  `);
  console.log('Database initialized');
}

initDb().catch(console.error);

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }
  try {
    const result = await db.query(
      `SELECT id, title, start_at as "startAt", end_at as "endAt" FROM events 
       WHERE start_at < $2 AND end_at > $1 
       ORDER BY start_at`,
      [start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const { title, startAt, endAt } = req.body;
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
    return res.status(400).json({ error: 'endAt must be after startAt' });
  }
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) 
       VALUES ($1, $2, $3) 
       RETURNING id, title, start_at as "startAt", end_at as "endAt"`,
      [title.trim(), startAt, endAt]
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
  const { title, startAt, endAt } = req.body;
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
    return res.status(400).json({ error: 'endAt must be after startAt' });
  }
  try {
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 
       WHERE id = $4 
       RETURNING id, title, start_at as "startAt", end_at as "endAt"`,
      [title.trim(), startAt, endAt, id]
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
      'DELETE FROM events WHERE id = $1 RETURNING id',
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