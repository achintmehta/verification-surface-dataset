import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pgdata'));

async function initDb() {
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
}

function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDbTimestamp(date) {
  // Store as an unzoned SQL timestamp using the ISO wall-clock fields supplied by JS.
  // The app is single-local-zone, and all API round trips use ISO strings.
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function serialize(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

function validateEventBody(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = parseDate(body.start_at ?? body.start);
  const end = parseDate(body.end_at ?? body.end);
  if (!title) return { error: 'Title is required' };
  if (!start || !end) return { error: 'Valid start_at and end_at ISO timestamps are required' };
  if (end <= start) return { error: 'end_at must be after start_at' };
  return { title, start, end };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    if (!start || !end || end <= start) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [toDbTimestamp(start), toDbTimestamp(end)]
    );
    res.json(result.rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const valid = validateEventBody(req.body || {});
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [valid.title, toDbTimestamp(valid.start), toDbTimestamp(valid.end)]
    );
    res.status(201).json(serialize(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id' });
    const valid = validateEventBody(req.body || {});
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [valid.title, toDbTimestamp(valid.start), toDbTimestamp(valid.end), id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json(serialize(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(__dirname));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Week calendar server listening on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
