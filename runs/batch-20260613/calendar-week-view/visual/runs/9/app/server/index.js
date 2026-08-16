import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = process.env.PORT || 3000;

const db = new PGlite(path.join(root, '.pglite-data'));

function toLocalTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  // PostgreSQL timestamp without time zone literal. If the client sent a local
  // YYYY-MM-DDTHH:mm form this preserves it; if it sent an ISO instant this is
  // still a sortable, valid timestamp accepted by PostgreSQL.
  return trimmed.replace('T', ' ').replace(/Z$/, '').replace(/[+-]\d\d:?\d\d$/, '').slice(0, 19);
}

function formatTimestamp(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
  }
  const text = String(value);
  const isoLike = text.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/);
  if (isoLike) return isoLike[0].replace(' ', 'T').padEnd(19, ':00');
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return formatTimestamp(parsed);
  return text.replace(' ', 'T').slice(0, 19);
}

function eventFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: formatTimestamp(row.start_at),
    end_at: formatTimestamp(row.end_at)
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
    CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at);
  `);
}

function readPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = toLocalTimestamp(body.start_at ?? body.start);
  const end = toLocalTimestamp(body.end_at ?? body.end);
  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at are required.' };
  if (new Date(start.replace(' ', 'T')).getTime() >= new Date(end.replace(' ', 'T')).getTime()) {
    return { error: 'end_at must be after start_at.' };
  }
  return { title, start, end };
}

await initDb();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = toLocalTimestamp(req.query.start);
    const end = toLocalTimestamp(req.query.end);
    if (!start || !end || new Date(start.replace(' ', 'T')) >= new Date(end.replace(' ', 'T'))) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1::timestamp AND end_at > $2::timestamp
       ORDER BY start_at, end_at, id`,
      [end, start]
    );
    res.json(result.rows.map(eventFromRow));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const payload = readPayload(req.body ?? {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [payload.title, payload.start, payload.end]
    );
    res.status(201).json(eventFromRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const payload = readPayload(req.body ?? {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [payload.title, payload.start, payload.end, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(eventFromRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const dist = path.join(root, 'dist');
app.use(express.static(dist));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend has not been built. Run npm run client for development or npm run build for production.');
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(port, () => {
  console.log(`Week calendar API listening on http://localhost:${port}`);
});
