import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const dbDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
const db = new PGlite(dbDir);

await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    CHECK (end_at > start_at)
  );
`);

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toOutput(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

function validateEventBody(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = parseDate(body.start_at ?? body.start);
  const end = parseDate(body.end_at ?? body.end);
  if (!title) return { error: 'Title is required' };
  if (!start || !end) return { error: 'Valid start_at and end_at are required' };
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
       ORDER BY start_at, end_at, id`,
      [start.toISOString(), end.toISOString()],
    );
    res.json(result.rows.map(toOutput));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const validation = validateEventBody(req.body ?? {});
    if (validation.error) return res.status(400).json({ error: validation.error });

    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [validation.title, validation.start.toISOString(), validation.end.toISOString()],
    );
    res.status(201).json(toOutput(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id' });

    const validation = validateEventBody(req.body ?? {});
    if (validation.error) return res.status(400).json({ error: validation.error });

    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [validation.title, validation.start.toISOString(), validation.end.toISOString(), id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(toOutput(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id' });

    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Week calendar API listening on http://localhost:${port}`);
  console.log(`PGLite data directory: ${dbDir}`);
});
