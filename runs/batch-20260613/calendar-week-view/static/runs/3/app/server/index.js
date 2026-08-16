import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'pglite');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

// Initialize PGLite with persistent storage
const db = new PGlite(DATA_DIR);

// Initialize schema
await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id        SERIAL PRIMARY KEY,
    title     TEXT        NOT NULL,
    start_at  TIMESTAMP   NOT NULL,
    end_at    TIMESTAMP   NOT NULL,
    CONSTRAINT end_after_start CHECK (end_at > start_at)
  );
  CREATE INDEX IF NOT EXISTS events_start_at_idx ON events (start_at);
  CREATE INDEX IF NOT EXISTS events_end_at_idx   ON events (end_at);
`);

const app = express();

app.use(cors());
app.use(express.json());

// ─── GET /api/events ─────────────────────────────────────────────────────────
// Query params: start=<iso>, end=<iso>
// Returns all events whose time range overlaps [start, end)
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query parameters are required' });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date format for start or end' });
  }

  try {
    // An event overlaps [start, end) when: event.start_at < end AND event.end_at > start
    const result = await db.query(
      `SELECT id, title,
              to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
              to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
       FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, end_at ASC`,
      [endDate.toISOString(), startDate.toISOString()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/events ─────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;

  // Validate title
  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  // Validate dates
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date format for start_at or end_at' });
  }

  if (endDate <= startDate) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), startDate.toISOString(), endDate.toISOString()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/events error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/events/:id ──────────────────────────────────────────────────────
app.put('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }

  const { title, start_at, end_at } = req.body;

  // Validate title
  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  // Validate dates
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date format for start_at or end_at' });
  }

  if (endDate <= startDate) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), startDate.toISOString(), endDate.toISOString(), id]
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/events/:id ───────────────────────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }

  try {
    const result = await db.query(
      'DELETE FROM events WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Calendar API server running on http://localhost:${PORT}`);
});
