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

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite(`file://${DATA_DIR}`);

async function initDb() {
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidIso(str) {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function validateEvent(body) {
  const errors = [];
  if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
    errors.push('title must be a non-empty string');
  }
  if (!isValidIso(body.start_at)) {
    errors.push('start_at must be a valid ISO timestamp');
  }
  if (!isValidIso(body.end_at)) {
    errors.push('end_at must be a valid ISO timestamp');
  }
  if (errors.length === 0) {
    const start = new Date(body.start_at);
    const end   = new Date(body.end_at);
    if (end <= start) {
      errors.push('end_at must be strictly after start_at');
    }
  }
  return errors;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!isValidIso(start) || !isValidIso(end)) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
  }
  try {
    // Return events that overlap the requested range:
    //   event.start_at < rangeEnd  AND  event.end_at > rangeStart
    const result = await db.query(
      `SELECT id, title,
              to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
              to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
       FROM events
       WHERE start_at < $1::timestamp
         AND end_at   > $2::timestamp
       ORDER BY start_at`,
      [end, start]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const errors = validateEvent(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }
  const { title, start_at, end_at } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), start_at, end_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/events error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ errors: ['end_at must be strictly after start_at'] });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }
  const errors = validateEvent(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }
  const { title, start_at, end_at } = req.body;
  try {
    const result = await db.query(
      `UPDATE events
       SET title    = $1,
           start_at = $2::timestamp,
           end_at   = $3::timestamp
       WHERE id = $4
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ errors: ['end_at must be strictly after start_at'] });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
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
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API server listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
