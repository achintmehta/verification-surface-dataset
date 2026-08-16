import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dbDir = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'data', 'pglite');
const port = Number(process.env.PORT || 3000);

const app = express();
const db = new PGlite(dbDir);

app.use(cors());
app.use(express.json());

function isValidDate(value) {
  const date = new Date(value);
  return typeof value === 'string' && !Number.isNaN(date.getTime());
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (btrim(title) <> ''),
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);
  `);
}

function validateEventBody(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = body?.start_at ?? body?.start;
  const end = body?.end_at ?? body?.end;
  if (!title) return { error: 'Title is required.' };
  if (!isValidDate(start) || !isValidDate(end)) return { error: 'Valid start_at and end_at ISO timestamps are required.' };
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (endDate <= startDate) return { error: 'end_at must be after start_at.' };
  return { title, startIso: startDate.toISOString(), endIso: endDate.toISOString() };
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
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [new Date(start).toISOString(), new Date(end).toISOString()],
    );
    res.json(result.rows.map(rowToEvent));
  } catch (error) {
    next(error);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const validated = validateEventBody(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [validated.title, validated.startIso, validated.endIso],
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id.' });
    const validated = validateEventBody(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [validated.title, validated.startIso, validated.endIso, id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((error, _req, res, next) => {
  void next;
  console.error(error);
  if (error?.message?.includes('violates check constraint')) {
    return res.status(400).json({ error: 'Invalid event.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

await initDb();
app.listen(port, () => {
  console.log(`Week calendar server listening on http://localhost:${port}`);
  console.log(`PGLite data directory: ${dbDir}`);
});
