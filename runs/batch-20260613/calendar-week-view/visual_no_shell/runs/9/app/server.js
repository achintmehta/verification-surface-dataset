import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

await db.query(`
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    CONSTRAINT events_end_after_start CHECK (end_at > start_at)
  );
`);

function isValidDate(value) {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime());
}

function asSqlTimestamp(value) {
  // Store an unambiguous UTC timestamp in a PostgreSQL TIMESTAMP column. The
  // client always converts back through Date(), so local-zone rendering remains
  // consistent for this single-user app.
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
}

function normalizeRow(row) {
  const toIso = (v) => {
    if (v instanceof Date) return v.toISOString();
    // PGLite commonly returns timestamp values as strings without a zone.
    return new Date(String(v).replace(' ', 'T') + (String(v).endsWith('Z') ? '' : 'Z')).toISOString();
  };
  return {
    id: row.id,
    title: row.title,
    start_at: toIso(row.start_at),
    end_at: toIso(row.end_at)
  };
}

function validateEventBody(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = body.start_at ?? body.start;
  const end = body.end_at ?? body.end;
  if (!title) return { error: 'Title is required.' };
  if (!isValidDate(start) || !isValidDate(end)) return { error: 'Valid start_at and end_at are required.' };
  if (new Date(end).getTime() <= new Date(start).getTime()) return { error: 'end_at must be after start_at.' };
  return { title, start_at: asSqlTimestamp(start), end_at: asSqlTimestamp(end) };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end) || new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1::timestamp AND end_at > $2::timestamp
       ORDER BY start_at, end_at, id`,
      [asSqlTimestamp(end), asSqlTimestamp(start)]
    );
    res.json(result.rows.map(normalizeRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const validated = validateEventBody(req.body ?? {});
    if (validated.error) return res.status(400).json({ error: validated.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [validated.title, validated.start_at, validated.end_at]
    );
    res.status(201).json(normalizeRow(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not create event.' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const validated = validateEventBody(req.body ?? {});
    if (validated.error) return res.status(400).json({ error: validated.error });
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [validated.title, validated.start_at, validated.end_at, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.json(normalizeRow(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not update event.' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete event.' });
  }
});

// The same Express process serves the vanilla frontend in development/start mode;
// Vite scripts remain available for a dedicated frontend dev server if desired.
app.use(express.static(process.cwd()));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile('index.html', { root: process.cwd() });
});

app.listen(PORT, () => {
  console.log(`Calendar API listening on http://localhost:${PORT}`);
});
