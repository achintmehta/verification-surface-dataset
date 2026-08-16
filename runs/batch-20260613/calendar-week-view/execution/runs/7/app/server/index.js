import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(rootDir, 'pgdata'));

await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    CHECK (end_at > start_at)
  );
  CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);
`);

function isValidDateString(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime());
}

function normalizeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: normalizeTimestamp(row.start_at),
    end_at: normalizeTimestamp(row.end_at)
  };
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return toLocalDateTimeString(value);
  return String(value).replace(' ', 'T').replace(/\.\d+$/, '').slice(0, 19);
}

function toLocalDateTimeString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function validateEventPayload(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start_at = body?.start_at ?? body?.start;
  const end_at = body?.end_at ?? body?.end;
  if (!title) return { error: 'Title is required.' };
  if (!isValidDateString(start_at) || !isValidDateString(end_at)) {
    return { error: 'Valid start_at and end_at are required.' };
  }
  if (new Date(end_at).getTime() <= new Date(start_at).getTime()) {
    return { error: 'end_at must be after start_at.' };
  }
  return { value: { title, start_at, end_at } };
}

function normalizeRangeQuery(req) {
  const { start, end } = req.query;
  if (!isValidDateString(start) || !isValidDateString(end)) {
    return { error: 'Valid start and end query parameters are required.' };
  }
  if (new Date(end).getTime() <= new Date(start).getTime()) {
    return { error: 'end must be after start.' };
  }
  return { value: { start, end } };
}

const eventSelect = 'SELECT id, title, start_at, end_at FROM events';

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/events', async (req, res) => {
  const parsed = normalizeRangeQuery(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { start, end } = parsed.value;
  const result = await db.query(
    `${eventSelect}
     WHERE start_at < $2::timestamp AND end_at > $1::timestamp
     ORDER BY start_at, end_at, id`,
    [start, end]
  );
  res.json(result.rows.map(normalizeEvent));
});

app.post('/api/events', async (req, res) => {
  const parsed = validateEventPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { title, start_at, end_at } = parsed.value;
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(normalizeEvent(result.rows[0]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

  const parsed = validateEventPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { title, start_at, end_at } = parsed.value;
  try {
    const result = await db.query(
      `UPDATE events
       SET title = $2, start_at = $3::timestamp, end_at = $4::timestamp
       WHERE id = $1
       RETURNING id, title, start_at, end_at`,
      [id, title, start_at, end_at]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.json(normalizeEvent(result.rows[0]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

  const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
  res.status(204).end();
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(200).send('Week Calendar API is running. Start the Vite dev server with npm run dev:client.');
  });
});

app.listen(port, () => {
  console.log(`Calendar API listening on http://localhost:${port}`);
});
