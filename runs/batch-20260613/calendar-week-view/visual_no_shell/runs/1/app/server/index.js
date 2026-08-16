import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'pglite');

mkdirSync(DATA_DIR, { recursive: true });

const db = new PGlite(DATA_DIR);

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
  console.log('Database initialized');
}

/**
 * Validate and normalise a datetime string to "YYYY-MM-DD HH:MM:SS".
 *
 * We accept:
 *   "2026-06-15T09:00"          → "2026-06-15 09:00:00"
 *   "2026-06-15T09:00:00"       → "2026-06-15 09:00:00"
 *   "2026-06-15T09:00:00.000"   → "2026-06-15 09:00:00"
 *
 * We deliberately do NOT parse through `new Date()` to avoid any
 * timezone conversion — the string is treated as a wall-clock value.
 *
 * Returns null if the string is not a recognisable local datetime.
 */
function parseWallClock(str) {
  if (typeof str !== 'string') return null;
  // Match YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS (with optional ms)
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  // Basic range checks
  const year = +y, month = +mo, day = +d, hour = +h, min = +mi, sec = +s;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${String(sec).padStart(2,'0')}`;
}

/**
 * Compare two wall-clock strings lexicographically.
 * Works because they are in "YYYY-MM-DD HH:MM:SS" format.
 */
function wallClockGt(a, b) {
  return a > b;
}

/**
 * Convert a value returned by PGLite for a TIMESTAMP column back to
 * a local ISO string "YYYY-MM-DDTHH:MM:SS".
 *
 * PGLite returns TIMESTAMP (no timezone) columns as JavaScript Date objects.
 * The Date is constructed by treating the stored wall-clock string as a local
 * time in the server's timezone. Since the server and browser share the same
 * timezone (single-user, same machine), we read back using LOCAL getters.
 *
 * If PGLite returns a plain string instead of a Date, we normalise the separator.
 */
function pgTimestampToLocal(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return `${val.getFullYear()}-${pad(val.getMonth()+1)}-${pad(val.getDate())}` +
           `T${pad(val.getHours())}:${pad(val.getMinutes())}:${pad(val.getSeconds())}`;
  }
  // Plain string — normalise space separator to T
  return String(val).replace(' ', 'T');
}

function serializeRow(row) {
  return {
    id:       row.id,
    title:    row.title,
    start_at: pgTimestampToLocal(row.start_at),
    end_at:   pgTimestampToLocal(row.end_at),
  };
}

const app = express();
app.use(cors());
app.use(express.json());

// ── GET /api/events?start=<local-iso>&end=<local-iso> ──────────────────────
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required' });
  }
  const startWall = parseWallClock(start);
  const endWall   = parseWallClock(end);
  if (!startWall || !endWall) {
    return res.status(400).json({ error: 'start and end must be valid local datetime strings' });
  }
  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, end_at DESC`,
      [endWall, startWall]
    );
    res.json(result.rows.map(serializeRow));
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/events ───────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startWall = parseWallClock(start_at);
  const endWall   = parseWallClock(end_at);

  if (!startWall) return res.status(400).json({ error: 'start_at must be a valid local datetime (YYYY-MM-DDTHH:MM)' });
  if (!endWall)   return res.status(400).json({ error: 'end_at must be a valid local datetime (YYYY-MM-DDTHH:MM)' });
  if (!wallClockGt(endWall, startWall)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title.trim(), startWall, endWall]
    );
    res.status(201).json(serializeRow(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/events/:id ────────────────────────────────────────────────────
app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, start_at, end_at } = req.body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }

  const startWall = parseWallClock(start_at);
  const endWall   = parseWallClock(end_at);

  if (!startWall) return res.status(400).json({ error: 'start_at must be a valid local datetime (YYYY-MM-DDTHH:MM)' });
  if (!endWall)   return res.status(400).json({ error: 'end_at must be a valid local datetime (YYYY-MM-DDTHH:MM)' });
  if (!wallClockGt(endWall, startWall)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title.trim(), startWall, endWall, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(serializeRow(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    if (err.message && err.message.includes('end_after_start')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/events/:id ─────────────────────────────────────────────────
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar API server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
