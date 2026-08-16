import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'calendar.db');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PGLite
let db;
async function initDB() {
  db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      title     TEXT NOT NULL,
      start_at  TEXT NOT NULL,
      end_at    TEXT NOT NULL,
      CHECK (end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS events_start_at_idx ON events (start_at);
    CREATE INDEX IF NOT EXISTS events_end_at_idx   ON events (end_at);
  `);
  console.log('Database initialized at', DB_PATH);
}

/**
 * Validate an ISO-like datetime string "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DDTHH:MM".
 * Returns a normalized "YYYY-MM-DDTHH:MM:SS" string or null if invalid.
 */
function normalizeDateTime(str) {
  if (typeof str !== 'string') return null;
  // Accept YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS
  const m = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/);
  if (!m) return null;
  return m[1] + (m[2] || ':00');
}

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }
  const normStart = normalizeDateTime(start);
  const normEnd   = normalizeDateTime(end);
  if (!normStart || !normEnd) {
    return res.status(400).json({ error: 'start and end must be valid ISO datetime strings' });
  }
  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at, end_at`,
      [normEnd, normStart]
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

  const normStart = normalizeDateTime(start_at);
  const normEnd   = normalizeDateTime(end_at);

  if (!normStart || !normEnd) {
    return res.status(400).json({ error: 'start_at and end_at must be valid ISO datetime strings (YYYY-MM-DDTHH:MM:SS)' });
  }
  if (normEnd <= normStart) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title.trim(), normStart, normEnd]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/events error:', err);
    if (err.message && (err.message.includes('check') || err.message.includes('CHECK'))) {
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

  const normStart = normalizeDateTime(start_at);
  const normEnd   = normalizeDateTime(end_at);

  if (!normStart || !normEnd) {
    return res.status(400).json({ error: 'start_at and end_at must be valid ISO datetime strings' });
  }
  if (normEnd <= normStart) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events SET title=$1, start_at=$2, end_at=$3
       WHERE id=$4
       RETURNING id, title, start_at, end_at`,
      [title.trim(), normStart, normEnd, parseInt(id, 10)]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    if (err.message && (err.message.includes('check') || err.message.includes('CHECK'))) {
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
      `DELETE FROM events WHERE id=$1 RETURNING id`,
      [parseInt(id, 10)]
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
