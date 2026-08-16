import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pgdata'));

await db.query(`
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    CONSTRAINT valid_event_time CHECK (end_at > start_at)
  );
`);

function isValidDate(value) {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime());
}

function validateEventPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start_at = body.start_at ?? body.start;
  const end_at = body.end_at ?? body.end;
  if (!title) return { error: 'Title is required' };
  if (!isValidDate(start_at) || !isValidDate(end_at)) return { error: 'Valid start_at and end_at are required' };
  if (new Date(end_at).getTime() <= new Date(start_at).getTime()) return { error: 'end_at must be after start_at' };
  return { title, start_at: new Date(start_at).toISOString(), end_at: new Date(end_at).toISOString() };
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end) || new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [new Date(start).toISOString(), new Date(end).toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const valid = validateEventPayload(req.body || {});
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamp, $3::timestamp)
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start_at, valid.end_at]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const valid = validateEventPayload(req.body || {});
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start_at, valid.end_at, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/src', express.static(path.join(__dirname, 'src')));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Week calendar listening on http://localhost:${PORT}`);
});
