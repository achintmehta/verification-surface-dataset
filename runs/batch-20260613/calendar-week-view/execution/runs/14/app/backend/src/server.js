import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ---- helpers ----------------------------------------------------------------

function isValidDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    // Always emit ISO 8601 UTC strings.
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

/**
 * Validate a create/update payload.
 * Returns { ok: true, data } or { ok: false, error }.
 */
function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const { title, start_at, end_at } = body;

  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  if (!isValidDate(start_at)) {
    return { ok: false, error: 'start_at must be a valid ISO timestamp' };
  }
  if (!isValidDate(end_at)) {
    return { ok: false, error: 'end_at must be a valid ISO timestamp' };
  }
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return {
    ok: true,
    data: {
      title: title.trim(),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
}

// ---- routes -----------------------------------------------------------------

// GET /api/events?start=<iso>&end=<iso>
// Returns all events that overlap the [start, end) range.
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end)) {
      return res
        .status(400)
        .json({ error: 'start and end query params must be valid ISO timestamps' });
    }
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();

    const db = await getDb();
    // Overlap condition: event starts before range end AND event ends after range start.
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $2 AND end_at > $1
        ORDER BY start_at ASC, end_at ASC, id ASC`,
      [startIso, endIso]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const validated = validatePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }
  try {
    const db = await getDb();
    const { title, start_at, end_at } = validated.data;
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
    return res.status(400).json({ error: 'id must be an integer' });
  }
  const validated = validatePayload(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }
  try {
    const db = await getDb();
    const { title, start_at, end_at } = validated.data;
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
    return res.status(400).json({ error: 'id must be an integer' });
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

// Kick off DB init then listen.
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Week calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });

export default app;
