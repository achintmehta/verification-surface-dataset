import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pgdata'));

function isValidDateValue(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function readEventPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start_at = body.start_at ?? body.start;
  const end_at = body.end_at ?? body.end;
  return { title, start_at, end_at };
}

function validateEventPayload(body) {
  const event = readEventPayload(body);
  if (!event.title) return { ok: false, error: 'Title is required' };
  if (!isValidDateValue(event.start_at) || !isValidDateValue(event.end_at)) {
    return { ok: false, error: 'Valid start_at and end_at are required' };
  }
  if (new Date(event.end_at).getTime() <= new Date(event.start_at).getTime()) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return { ok: true, event };
}

function normalizeRow(row) {
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
  await db.query(`CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at);`);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!isValidDateValue(start) || !isValidDateValue(end) || new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [new Date(start).toISOString(), new Date(end).toISOString()]
    );
    res.json(result.rows.map(normalizeRow));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const validation = validateEventPayload(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.event;
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [title, new Date(start_at).toISOString(), new Date(end_at).toISOString()]
    );
    res.status(201).json(normalizeRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const validation = validateEventPayload(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const { title, start_at, end_at } = validation.event;
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, new Date(start_at).toISOString(), new Date(end_at).toISOString(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(normalizeRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(__dirname));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.message?.includes('check constraint')) {
    return res.status(400).json({ error: 'Invalid event' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Week calendar server listening on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
