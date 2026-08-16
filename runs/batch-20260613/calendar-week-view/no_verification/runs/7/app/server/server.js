import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const port = process.env.PORT || 3000;
const dbDir = process.env.PGLITE_DATA_DIR || './pgdata';
const db = new PGlite(dbDir);

app.use(cors());
app.use(express.json());

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CONSTRAINT events_end_after_start CHECK (end_at > start_at)
    );
  `);
  await db.query('CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at);');
}

function isValidDateInput(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function assertEventPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = body.start_at ?? body.start;
  const end = body.end_at ?? body.end;
  if (!title) return { ok: false, message: 'Title is required.' };
  if (!isValidDateInput(start) || !isValidDateInput(end)) {
    return { ok: false, message: 'Valid start_at and end_at are required.' };
  }
  if (new Date(end).getTime() <= new Date(start).getTime()) {
    return { ok: false, message: 'end_at must be after start_at.' };
  }
  return { ok: true, event: { title, start_at: start, end_at: end } };
}

function rowToEvent(row) {
  return {
    id: Number(row.id),
    title: row.title,
    start_at: row.start_at,
    end_at: row.end_at
  };
}

const eventSelect = `
  SELECT
    id,
    title,
    to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
    to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
  FROM events
`;

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!isValidDateInput(start) || !isValidDateInput(end) || new Date(end).getTime() <= new Date(start).getTime()) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `${eventSelect}
       WHERE start_at < $2::timestamp AND end_at > $1::timestamp
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [start, end]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const validated = assertEventPayload(req.body || {});
    if (!validated.ok) return res.status(400).json({ error: validated.message });
    const { title, start_at, end_at } = validated.event;
    const inserted = await db.query(
      'INSERT INTO events (title, start_at, end_at) VALUES ($1, $2::timestamp, $3::timestamp) RETURNING id',
      [title, start_at, end_at]
    );
    const result = await db.query(`${eventSelect} WHERE id = $1`, [inserted.rows[0].id]);
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id.' });
    const validated = assertEventPayload(req.body || {});
    if (!validated.ok) return res.status(400).json({ error: validated.message });
    const { title, start_at, end_at } = validated.event;
    const updated = await db.query(
      'UPDATE events SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp WHERE id = $4 RETURNING id',
      [title, start_at, end_at, id]
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'Event not found.' });
    const result = await db.query(`${eventSelect} WHERE id = $1`, [id]);
    res.json(rowToEvent(result.rows[0]));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update event.' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid event id.' });
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

initDb().then(() => {
  app.listen(port, () => console.log(`Week calendar API listening on http://localhost:${port}`));
}).catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
