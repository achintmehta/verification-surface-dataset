import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, 'pglite-data');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DB_DIR);

function isValidDate(value) {
  const d = new Date(value);
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(d.getTime());
}

function normalizeTitle(title) {
  return typeof title === 'string' ? title.trim() : '';
}

function validateEventPayload(body) {
  const title = normalizeTitle(body?.title);
  const start = body?.start_at ?? body?.start;
  const end = body?.end_at ?? body?.end;
  if (!title) return { error: 'Title is required' };
  if (!isValidDate(start) || !isValidDate(end)) return { error: 'Valid start_at and end_at are required' };
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (endDate <= startDate) return { error: 'end_at must be after start_at' };
  return { value: { title, start_at: startDate.toISOString(), end_at: endDate.toISOString() } };
}

function mapRow(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
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
  await db.query('CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);');
}

app.get('/api/events', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end) || new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1::timestamp AND end_at > $2::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [new Date(end).toISOString(), new Date(start).toISOString()]
    );
    res.json(result.rows.map(mapRow));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const validation = validateEventPayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(mapRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id' });
    const validation = validateEventPayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.value;
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(mapRow(result.rows[0]));
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

const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Week calendar server listening on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
