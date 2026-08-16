import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'pglite-data');
const port = Number(process.env.PORT || 3000);

const db = new PGlite(dataDir);

function isoToLocalTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  // Store local wall-clock timestamp in PostgreSQL timestamp without time zone.
  // API consumers send/receive ISO strings; converting through Date gives a stable sortable value.
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function rowToEvent(row) {
  const norm = (v) => {
    if (v instanceof Date) return v.toISOString();
    // PGLite can return timestamp strings with a space separator. Treat them as local time.
    return new Date(String(v).replace(' ', 'T')).toISOString();
  };
  return {
    id: row.id,
    title: row.title,
    start_at: norm(row.start_at),
    end_at: norm(row.end_at)
  };
}

function validateEventBody(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = body?.start_at || body?.start;
  const end = body?.end_at || body?.end;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!title) return { error: 'Title is required' };
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    return { error: 'Valid start_at and end_at are required' };
  }
  if (endDate <= startDate) return { error: 'end_at must be after start_at' };
  return {
    value: {
      title,
      start_at: isoToLocalTimestamp(startDate.toISOString()),
      end_at: isoToLocalTimestamp(endDate.toISOString())
    }
  };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS events_time_idx ON events (start_at, end_at);
  `);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const startTs = isoToLocalTimestamp(req.query.start);
    const endTs = isoToLocalTimestamp(req.query.end);
    if (!startTs || !endTs || new Date(req.query.end) <= new Date(req.query.start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2 AND end_at > $1
       ORDER BY start_at, end_at, id`,
      [startTs, endTs]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const validation = validateEventBody(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const validation = validateEventBody(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (err) => {
    if (err) res.status(404).send('Run npm run build to create the production frontend, or npm run dev for Vite.');
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await initDb();
app.listen(port, () => {
  console.log(`Calendar API listening on http://localhost:${port}`);
});
