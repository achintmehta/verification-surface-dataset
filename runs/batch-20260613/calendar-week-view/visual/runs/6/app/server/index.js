import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(rootDir, 'pglite-data'));

function isValidDate(value) {
  const d = new Date(value);
  return typeof value === 'string' && Number.isFinite(d.getTime());
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDbTimestamp(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}T${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
  }
  return String(value).replace(' ', 'T').replace(/\.\d+$/, '');
}

function normalizeRow(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: normalizeTimestamp(row.start_at),
    end_at: normalizeTimestamp(row.end_at),
  };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS idx_events_start_end ON events (start_at, end_at);
  `);
}

function validateEventPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start_at = body.start_at ?? body.start;
  const end_at = body.end_at ?? body.end;
  if (!title) return { error: 'Title is required.' };
  if (!isValidDate(start_at) || !isValidDate(end_at)) return { error: 'Valid start_at and end_at ISO timestamps are required.' };
  const startDate = new Date(start_at);
  const endDate = new Date(end_at);
  if (endDate <= startDate) return { error: 'end_at must be after start_at.' };
  return { value: { title, start_at: toDbTimestamp(start_at), end_at: toDbTimestamp(end_at) } };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end) || new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1::timestamp AND end_at > $2::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [toDbTimestamp(end), toDbTimestamp(start)]
    );
    res.json(result.rows.map(normalizeRow));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const validation = validateEventPayload(req.body || {});
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(normalizeRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const validation = validateEventPayload(req.body || {});
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.json(normalizeRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.message?.includes('check constraint')) {
    return res.status(400).json({ error: 'end_at must be after start_at.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

await initDb();
app.listen(port, () => {
  console.log(`Week calendar API listening on http://localhost:${port}`);
});
