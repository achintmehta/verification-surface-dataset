import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const DATABASE_DIR = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'pgdata');

const db = new PGlite(DATABASE_DIR);

await db.query(`
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    CHECK (end_at > start_at)
  );
`);

const app = express();
app.use(cors());
app.use(express.json());

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // PostgreSQL accepts ISO-like input. We keep offset-free local datetime strings
  // offset-free, and preserve explicitly offsetted ISO input as valid too.
  return value;
}

function eventFromBody(body) {
  const title = isNonEmptyString(body?.title) ? body.title.trim() : null;
  const start_at = parseTimestamp(body?.start_at ?? body?.start);
  const end_at = parseTimestamp(body?.end_at ?? body?.end);
  if (!title || !start_at || !end_at) {
    return { error: 'title, start_at, and end_at are required' };
  }
  if (new Date(end_at).getTime() <= new Date(start_at).getTime()) {
    return { error: 'end_at must be after start_at' };
  }
  return { title, start_at, end_at };
}

function asDateTimeString(value) {
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  if (typeof value === 'string') {
    return value.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1');
  }
  return value;
}

function serialize(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: asDateTimeString(row.start_at),
    end_at: asDateTimeString(row.end_at)
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = parseTimestamp(req.query.start);
    const end = parseTimestamp(req.query.end);
    if (!start || !end || new Date(end).getTime() <= new Date(start).getTime()) {
      return res.status(400).json({ error: 'valid start and end query parameters are required' });
    }

    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at, end_at, id`,
      [start, end]
    );
    res.json(result.rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const event = eventFromBody(req.body);
    if (event.error) return res.status(400).json({ error: event.error });

    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [event.title, event.start_at, event.end_at]
    );
    res.status(201).json(serialize(result.rows[0]));
  } catch (err) {
    if (String(err?.message || '').includes('check')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const event = eventFromBody(req.body);
    if (event.error) return res.status(400).json({ error: event.error });

    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [event.title, event.start_at, event.end_at, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'event not found' });
    res.json(serialize(result.rows[0]));
  } catch (err) {
    if (String(err?.message || '').includes('check')) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// In production, serve Vite's dist folder when present. In development this
// server also serves the source tree directly so `npm run dev` needs only one
// process in constrained environments; Vite remains available via `npm run client`.
const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.use(express.static(rootDir));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.sendFile(path.join(rootDir, 'index.html'));
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Calendar API listening on http://localhost:${PORT}`);
});
