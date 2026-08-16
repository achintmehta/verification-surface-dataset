import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'pglite-data');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

const db = new PGlite(dataDir);

function isoToDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at);`);
}

function validateEventBody(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = isoToDate(body?.start_at ?? body?.start);
  const end = isoToDate(body?.end_at ?? body?.end);
  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at are required.' };
  if (end.getTime() <= start.getTime()) return { error: 'end_at must be after start_at.' };
  return { title, start_at: start.toISOString(), end_at: end.toISOString() };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = isoToDate(req.query.start);
    const end = isoToDate(req.query.end);
    if (!start || !end || end.getTime() <= start.getTime()) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1::timestamp AND end_at > $2::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
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
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start_at, valid.end_at]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const valid = validateEventBody(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start_at, valid.end_at, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

await initDb();
app.listen(port, () => {
  console.log(`Week calendar server listening on http://localhost:${port}`);
});
