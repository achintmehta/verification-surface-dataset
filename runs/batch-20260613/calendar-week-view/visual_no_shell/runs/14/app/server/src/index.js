import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helpers
function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function validateEventInput(body) {
  const errors = [];
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('title must be a non-empty string');

  if (!isValidDate(body.start_at)) errors.push('start_at must be a valid ISO timestamp');
  if (!isValidDate(body.end_at)) errors.push('end_at must be a valid ISO timestamp');

  if (errors.length === 0) {
    const start = new Date(body.start_at);
    const end = new Date(body.end_at);
    if (!(end.getTime() > start.getTime())) {
      errors.push('end_at must be after start_at');
    }
  }
  return { errors, title };
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end)) {
      return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
    }
    const db = await getDb();
    // Overlap: event.start_at < range.end AND event.end_at > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at ASC, id ASC`,
      [new Date(end).toISOString(), new Date(start).toISOString()]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const { errors, title } = validateEventInput(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, new Date(req.body.start_at).toISOString(), new Date(req.body.end_at).toISOString()]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const { errors, title } = validateEventInput(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }
    const db = await getDb();
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, new Date(req.body.start_at).toISOString(), new Date(req.body.end_at).toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'event not found' });
    }
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'event not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });
