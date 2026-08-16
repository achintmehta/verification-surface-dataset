import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'pgdata');
const PORT = process.env.PORT || 3000;

await mkdir(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);
await db.query(`
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    CHECK (end_at > start_at)
  );
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return value;
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: toIso(row.start_at),
    end_at: toIso(row.end_at)
  };
}

function getPayload(body) {
  return {
    title: typeof body.title === 'string' ? body.title.trim() : '',
    start_at: body.start_at ?? body.start,
    end_at: body.end_at ?? body.end
  };
}

function validateEventPayload(body) {
  const payload = getPayload(body || {});
  const start = parseInstant(payload.start_at);
  const end = parseInstant(payload.end_at);
  if (!payload.title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Start and end must be valid ISO date-times.' };
  if (end <= start) return { error: 'End time must be after start time.' };
  return { title: payload.title, start, end };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = parseInstant(req.query.start);
    const end = parseInstant(req.query.end);
    if (!start || !end || end <= start) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $2::timestamptz
          AND end_at > $1::timestamptz
        ORDER BY start_at ASC, end_at ASC, id ASC`,
      [start.toISOString(), end.toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const valid = validateEventPayload(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamptz, $3::timestamptz)
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start.toISOString(), valid.end.toISOString()]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid event id.' });
    const valid = validateEventPayload(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `UPDATE events
          SET title = $1, start_at = $2::timestamptz, end_at = $3::timestamptz
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start.toISOString(), valid.end.toISOString(), id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid event id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const frontendDir = path.join(__dirname, 'frontend');
app.use(express.static(frontendDir));
app.get('*', (_req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Week calendar server listening at http://localhost:${PORT}`);
});
