import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const DATABASE_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, 'data', 'pglite');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DATABASE_DIR);

function parseDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDbTimestamp(date) {
  return date.toISOString();
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
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
    CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);
  `);
}

function validateEventPayload(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = parseDate(body?.start_at ?? body?.start);
  const end = parseDate(body?.end_at ?? body?.end);
  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at ISO timestamps are required.' };
  if (end.getTime() <= start.getTime()) return { error: 'end_at must be after start_at.' };
  return { title, start, end };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/events', async (req, res, next) => {
  try {
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    if (!start || !end || end.getTime() <= start.getTime()) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }

    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2 AND end_at > $1
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [toDbTimestamp(start), toDbTimestamp(end)]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (error) {
    next(error);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const valid = validateEventPayload(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });

    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [valid.title, toDbTimestamp(valid.start), toDbTimestamp(valid.end)]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id.' });

    const valid = validateEventPayload(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });

    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [valid.title, toDbTimestamp(valid.start), toDbTimestamp(valid.end), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Week calendar server listening on http://localhost:${PORT}`);
  console.log(`PGLite database at ${DATABASE_DIR}`);
});
