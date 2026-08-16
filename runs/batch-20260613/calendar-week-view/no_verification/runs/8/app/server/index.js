import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'pglite-data');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const db = new PGlite(dataDir);

await db.query(`
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

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

function validateEventBody(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = parseDate(body?.start_at ?? body?.start);
  const end = parseDate(body?.end_at ?? body?.end);

  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at ISO timestamps are required.' };
  if (end.getTime() <= start.getTime()) return { error: 'end_at must be after start_at.' };

  return { title, startIso: start.toISOString(), endIso: end.toISOString() };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at, end_at, id`,
      [end.toISOString(), start.toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const valid = validateEventBody(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });

    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.startIso, valid.endIso]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

    const valid = validateEventBody(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });

    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.startIso, valid.endIso, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const frontendDist = path.join(rootDir, 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get(/.*/, (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(port, () => {
  console.log(`Week calendar API listening on http://localhost:${port}`);
});
