import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate incoming event payload. Returns { error } or { value }.
function validateEventBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  const { title, start_at, end_at } = body;
  if (typeof title !== 'string' || title.trim() === '') {
    return { error: 'Title must be a non-empty string' };
  }
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime())) {
    return { error: 'start_at must be a valid date' };
  }
  if (Number.isNaN(end.getTime())) {
    return { error: 'end_at must be a valid date' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { error: 'end_at must be after start_at' };
  }
  return { value: { title: title.trim(), start_at: start.toISOString(), end_at: end.toISOString() } };
}

// GET events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required' });
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'start and end must be valid ISO dates' });
  }
  try {
    const db = await getDb();
    // Overlap: event.start_at < range.end AND event.end_at > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, id ASC`,
      [endDate.toISOString(), startDate.toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST create event
app.post('/api/events', async (req, res) => {
  const { error, value } = validateEventBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [value.title, value.start_at, value.end_at]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT update event
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const { error, value } = validateEventBody(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [value.title, value.start_at, value.end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE event
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
