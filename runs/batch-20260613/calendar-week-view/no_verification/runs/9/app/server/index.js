import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');

const db = new PGlite(DATA_DIR);

function normalizeDateInput(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  // PostgreSQL timestamp accepts ISO-like strings. For local calendar semantics the
  // client sends values without a trailing timezone; keep that representation.
  return trimmed.replace(/Z$/, '').replace(/\.\d{3,}/, '');
}

function validateEventBody(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const startRaw = body?.start_at ?? body?.start;
  const endRaw = body?.end_at ?? body?.end;
  const start_at = normalizeDateInput(startRaw);
  const end_at = normalizeDateInput(endRaw);

  if (!title) return { error: 'title is required' };
  if (!start_at || !end_at) return { error: 'valid start_at and end_at are required' };
  if (!(new Date(end_at).getTime() > new Date(start_at).getTime())) {
    return { error: 'end_at must be after start_at' };
  }
  return { value: { title, start_at, end_at } };
}

function rowToEvent(row) {
  return {
    id: Number(row.id),
    title: row.title,
    start_at: row.start_at,
    end_at: row.end_at
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
  await db.query('CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at);');
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = normalizeDateInput(req.query.start);
    const end = normalizeDateInput(req.query.end);
    if (!start || !end || !(new Date(end).getTime() > new Date(start).getTime())) {
      return res.status(400).json({ error: 'valid start and end query parameters are required' });
    }

    const result = await db.query(
      `SELECT id, title,
              to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
              to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
       FROM events
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at, end_at, id`,
      [start, end]
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
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
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
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const validation = validateEventBody(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title,
                 to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                 to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
      [title, start_at, end_at, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'event not found' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.message?.includes('check constraint')) {
    return res.status(400).json({ error: 'invalid event' });
  }
  res.status(500).json({ error: 'internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Week calendar API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
