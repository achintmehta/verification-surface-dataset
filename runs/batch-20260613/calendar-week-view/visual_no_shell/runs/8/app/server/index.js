import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(process.cwd(), 'pgdata'));

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CHECK (end_at > start_at)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);`);
}

function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function validateEventPayload(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = parseDate(body?.start_at ?? body?.start);
  const end = parseDate(body?.end_at ?? body?.end);
  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at are required.' };
  if (end <= start) return { error: 'end_at must be after start_at.' };
  return { title, start, end };
}

function rowToEvent(row) {
  const toIso = (v) => v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return {
    id: row.id,
    title: row.title,
    start_at: toIso(row.start_at),
    end_at: toIso(row.end_at)
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    if (!start || !end || end <= start) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $2 AND end_at > $1
        ORDER BY start_at ASC, end_at ASC, id ASC`,
      [start.toISOString(), end.toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    next(err);
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
      [valid.title, valid.start.toISOString(), valid.end.toISOString()]
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
    const valid = validateEventPayload(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `UPDATE events
          SET title = $1, start_at = $2, end_at = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start.toISOString(), valid.end.toISOString(), id]
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

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return res.status(200).send('Calendar API is running. Start the Vite dev server with npm run client for the frontend.');
  }
  res.sendFile(indexFile, (err) => {
    if (err) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Calendar API listening on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
