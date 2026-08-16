import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data', 'pglite');
mkdirSync(DATA_DIR, { recursive: true });

const db = new PGlite(DATA_DIR);

await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id        SERIAL PRIMARY KEY,
    title     TEXT        NOT NULL,
    start_at  TIMESTAMP   NOT NULL,
    end_at    TIMESTAMP   NOT NULL,
    CONSTRAINT end_after_start CHECK (end_at > start_at)
  );
`);

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Normalise a timestamp string to a wall-clock (no-timezone) string
 * suitable for storing in a TIMESTAMP (without time zone) column.
 *
 * The frontend always sends ISO strings that represent the user's local
 * wall-clock time.  We strip any trailing 'Z' or '+HH:MM' offset so that
 * PostgreSQL stores and compares the value as a plain local datetime.
 *
 * Examples:
 *   "2026-06-15T09:00:00.000Z"  → "2026-06-15T09:00:00"
 *   "2026-06-15T09:00"          → "2026-06-15T09:00"
 *   "2026-06-15T09:00:00+05:30" → "2026-06-15T09:00:00"
 */
function toWallClock(isoStr) {
  if (!isoStr) return isoStr;
  // Remove trailing Z
  let s = String(isoStr).replace(/Z$/, '');
  // Remove +HH:MM or -HH:MM offset
  s = s.replace(/[+-]\d{2}:\d{2}$/, '');
  return s;
}

/**
 * Format a JS Date as a wall-clock ISO string "YYYY-MM-DDTHH:MM:SS"
 * using the *local* time components (no UTC conversion).
 */
function dateToWallClock(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Parse a wall-clock string "YYYY-MM-DDTHH:MM:SS" into a JS Date
 * treating it as local time (append no offset).
 */
function parseWallClock(str) {
  // new Date("YYYY-MM-DDTHH:MM:SS") is parsed as LOCAL time in modern engines
  return new Date(str);
}

/**
 * Validate and normalise a timestamp value from the request body.
 * Returns { ok: true, value: wallClockString } or { ok: false, error: string }.
 */
function validateTimestamp(raw, fieldName) {
  if (!raw) return { ok: false, error: `${fieldName} is required` };
  const wall = toWallClock(String(raw));
  const d = parseWallClock(wall);
  if (isNaN(d.getTime())) {
    return { ok: false, error: `${fieldName} must be a valid datetime` };
  }
  return { ok: true, value: wall };
}

// ─── GET /api/events?start=<wall-clock>&end=<wall-clock> ─────────────────────
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }

  const wallStart = toWallClock(start);
  const wallEnd   = toWallClock(end);

  try {
    const result = await db.query(
      `SELECT id, title,
              to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
              to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
       FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at`,
      [wallEnd, wallStart]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/events ─────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  const sv = validateTimestamp(start_at, 'start_at');
  if (!sv.ok) return res.status(400).json({ error: sv.error });

  const ev = validateTimestamp(end_at, 'end_at');
  if (!ev.ok) return res.status(400).json({ error: ev.error });

  if (parseWallClock(ev.value) <= parseWallClock(sv.value)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at,   'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title.trim(), sv.value, ev.value]
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

// ─── PUT /api/events/:id ──────────────────────────────────────────────────────
app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, start_at, end_at } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  const sv = validateTimestamp(start_at, 'start_at');
  if (!sv.ok) return res.status(400).json({ error: sv.error });

  const ev = validateTimestamp(end_at, 'end_at');
  if (!ev.ok) return res.status(400).json({ error: ev.error });

  if (parseWallClock(ev.value) <= parseWallClock(sv.value)) {
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
      [title.trim(), sv.value, ev.value, id]
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

// ─── DELETE /api/events/:id ───────────────────────────────────────────────────
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
app.listen(PORT, () => {
  console.log(`Calendar API server running on http://localhost:${PORT}`);
});
