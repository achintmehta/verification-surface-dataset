import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data', 'pglite');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PGLite
let db;

async function initDB() {
  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      title     TEXT NOT NULL,
      start_at  TIMESTAMP NOT NULL,
      end_at    TIMESTAMP NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS events_start_at_idx ON events (start_at);
    CREATE INDEX IF NOT EXISTS events_end_at_idx   ON events (end_at);
  `);

  console.log('PGLite initialized at', DATA_DIR);
}

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }

  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC`,
      [end, start]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'start_at and end_at must be valid ISO timestamps' });
  }
  if (endDate <= startDate) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title.trim(), start_at, end_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/events error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, start_at, end_at } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'start_at and end_at must be valid ISO timestamps' });
  }
  if (endDate <= startDate) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title.trim(), start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    res.status(500).json({ error: err.message });
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
    res.json({ deleted: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar API server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
