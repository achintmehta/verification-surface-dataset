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

// Initialize PGLite with filesystem persistence
const db = new PGlite(`file://${DATA_DIR}`);

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidISO(str) {
  if (typeof str !== 'string' || str.trim() === '') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function parseTimestamp(val) {
  if (val instanceof Date) return val.toISOString();
  // PGLite may return timestamps as strings like "2025-01-06T09:00:00.000Z"
  // or "2025-01-06 09:00:00" — normalise to ISO string.
  const s = String(val).replace(' ', 'T');
  // If no timezone indicator, treat as UTC (we always store UTC)
  const withZ = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z';
  return new Date(withZ).toISOString();
}

function rowToEvent(row) {
  return {
    id:       row.id,
    title:    row.title,
    start_at: parseTimestamp(row.start_at),
    end_at:   parseTimestamp(row.end_at),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/events?start=<iso>&end=<iso>
// Returns all events that overlap [start, end)
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!isValidISO(start) || !isValidISO(end)) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
  }
  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1
          AND end_at   > $2
        ORDER BY start_at, id`,
      [end, start]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body ?? {};

  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!isValidISO(start_at)) {
    return res.status(400).json({ error: 'start_at must be a valid ISO timestamp' });
  }
  if (!isValidISO(end_at)) {
    return res.status(400).json({ error: 'end_at must be a valid ISO timestamp' });
  }
  const start = new Date(start_at);
  const end   = new Date(end_at);
  if (end <= start) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title.trim(), start.toISOString(), end.toISOString()]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid event id' });

  const { title, start_at, end_at } = req.body ?? {};

  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!isValidISO(start_at)) {
    return res.status(400).json({ error: 'start_at must be a valid ISO timestamp' });
  }
  if (!isValidISO(end_at)) {
    return res.status(400).json({ error: 'end_at must be a valid ISO timestamp' });
  }
  const start = new Date(start_at);
  const end   = new Date(end_at);
  if (end <= start) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events
          SET title    = $1,
              start_at = $2,
              end_at   = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [title.trim(), start.toISOString(), end.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid event id' });

  try {
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
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

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Calendar API server listening on http://localhost:${PORT}`);
});
