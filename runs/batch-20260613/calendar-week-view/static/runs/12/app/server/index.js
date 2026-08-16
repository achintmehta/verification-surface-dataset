import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate the body of a create/update request.
// Returns { ok: true, value } or { ok: false, error }.
function validateEventInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const { title, start_at, end_at } = body;

  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  if (typeof start_at !== 'string' || typeof end_at !== 'string') {
    return { ok: false, error: 'start_at and end_at must be ISO date strings' };
  }
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'start_at and end_at must be valid dates' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return {
    ok: true,
    value: {
      title: title.trim(),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
}

// GET /api/events?start=<iso>&end=<iso>
// Returns all events overlapping [start, end).
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = await getDb();
    let result;
    if (start && end) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ error: 'Invalid start or end query parameter' });
      }
      // Overlap condition: event.start_at < range.end AND event.end_at > range.start
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         WHERE start_at < $1 AND end_at > $2
         ORDER BY start_at ASC, id ASC`,
        [endDate.toISOString(), startDate.toISOString()]
      );
    } else {
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events ORDER BY start_at ASC, id ASC`
      );
    }
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const validation = validateEventInput(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  try {
    const { title, start_at, end_at } = validation.value;
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }
  const validation = validateEventInput(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  try {
    const { title, start_at, end_at } = validation.value;
    const db = await getDb();
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
