import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Validation helpers -----------------------------------------------------

function parseIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate the body for create/update. Returns { error } or { title, startAt, endAt }.
function validateEventBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object.' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title === '') {
    return { error: 'Title must be a non-empty string.' };
  }
  const startAt = parseIso(body.start_at);
  const endAt = parseIso(body.end_at);
  if (!startAt) return { error: 'start_at must be a valid ISO timestamp.' };
  if (!endAt) return { error: 'end_at must be a valid ISO timestamp.' };
  if (!(endAt.getTime() > startAt.getTime())) {
    return { error: 'end_at must be after start_at.' };
  }
  return { title, startAt, endAt };
}

// --- Routes ------------------------------------------------------------------

// GET /api/events?start=<iso>&end=<iso>
// Returns every event overlapping the [start, end) range.
app.get('/api/events', async (req, res) => {
  const start = parseIso(req.query.start);
  const end = parseIso(req.query.end);
  if (!start || !end) {
    return res
      .status(400)
      .json({ error: 'Query params start and end must be valid ISO timestamps.' });
  }
  try {
    const db = await getDb();
    // Overlap: event.start < range.end AND event.end > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1 AND end_at > $2
        ORDER BY start_at ASC, id ASC`,
      [end.toISOString(), start.toISOString()]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const parsed = validateEventBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.startAt.toISOString(), parsed.endAt.toISOString()]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events failed', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }
  const parsed = validateEventBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events
          SET title = $1, start_at = $2, end_at = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.startAt.toISOString(), parsed.endAt.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Start the server after the database is ready.
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Week-calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });

export { app, validateEventBody };
