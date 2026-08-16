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
const db = new PGlite(DATA_DIR);

// Initialize schema
await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id        SERIAL PRIMARY KEY,
    title     TEXT        NOT NULL CHECK (length(trim(title)) > 0),
    start_at  TIMESTAMP   NOT NULL,
    end_at    TIMESTAMP   NOT NULL,
    CHECK (end_at > start_at)
  );
`);

const app = express();

app.use(cors());
app.use(express.json());

// Serve built frontend in production
const clientDist = join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate and normalise a datetime string.
 * Accepts:
 *   - "YYYY-MM-DDTHH:MM:SS"   (local, no timezone — preferred)
 *   - "YYYY-MM-DDTHH:MM"      (local, no timezone)
 *   - Any string parseable by Date (UTC ISO, etc.)
 *
 * Returns a "YYYY-MM-DDTHH:MM:SS" string suitable for PostgreSQL TIMESTAMP,
 * or null if the input is invalid.
 *
 * Strategy: if the string has no timezone indicator (no Z, no +/-offset),
 * treat it as local time and pass it straight through to PG (which also
 * treats TIMESTAMP values as local/unzoned).  If it has a timezone, convert
 * to local time first so the stored value is always in the same frame.
 */
function normaliseTimestamp(str) {
  if (!str || typeof str !== 'string') return null;

  const trimmed = str.trim();

  // Check if it already looks like a local datetime (no Z, no offset)
  // Pattern: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS
  const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
  if (localPattern.test(trimmed)) {
    // Ensure seconds are present
    return trimmed.length === 16 ? trimmed + ':00' : trimmed;
  }

  // Has timezone info — parse and convert to local
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Compare two normalised timestamp strings lexicographically.
 * Works because they are in YYYY-MM-DDTHH:MM:SS format.
 */
function tsCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── GET /api/events?start=<iso>&end=<iso> ────────────────────────────────────
// Returns all events that overlap the given range [start, end).
// An event overlaps if: event.start_at < range_end AND event.end_at > range_start
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query parameters are required' });
  }

  const rangeStart = normaliseTimestamp(start);
  const rangeEnd   = normaliseTimestamp(end);

  if (!rangeStart || !rangeEnd) {
    return res.status(400).json({ error: 'Invalid date format for start or end' });
  }

  try {
    const result = await db.query(
      `SELECT id, title,
              to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
              to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
       FROM events
       WHERE start_at < $1::timestamp AND end_at > $2::timestamp
       ORDER BY start_at, id`,
      [rangeEnd, rangeStart]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/events ─────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;

  // Validate title
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  // Validate timestamps
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startTs = normaliseTimestamp(start_at);
  const endTs   = normaliseTimestamp(end_at);

  if (!startTs || !endTs) {
    return res.status(400).json({ error: 'Invalid date format for start_at or end_at' });
  }

  if (tsCompare(endTs, startTs) <= 0) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), startTs, endTs]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/events error:', err);
    res.status(500).json({ error: 'Database error' });
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
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  // Validate timestamps
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startTs = normaliseTimestamp(start_at);
  const endTs   = normaliseTimestamp(end_at);

  if (!startTs || !endTs) {
    return res.status(400).json({ error: 'Invalid date format for start_at or end_at' });
  }

  if (tsCompare(endTs, startTs) <= 0) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), startTs, endTs, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    res.status(500).json({ error: 'Database error' });
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

    res.json({ deleted: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Calendar API server listening on http://localhost:${PORT}`);
});
