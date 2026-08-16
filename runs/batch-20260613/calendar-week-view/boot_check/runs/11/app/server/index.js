import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Validation helpers -----------------------------------------------------

function parseEventBody(body) {
  const errors = [];
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('title must be a non-empty string');

  const start = body?.start_at != null ? new Date(body.start_at) : null;
  const end = body?.end_at != null ? new Date(body.end_at) : null;

  if (!start || Number.isNaN(start.getTime())) errors.push('start_at must be a valid datetime');
  if (!end || Number.isNaN(end.getTime())) errors.push('end_at must be a valid datetime');

  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
    if (end.getTime() <= start.getTime()) errors.push('end_at must be after start_at');
  }

  return { title, start, end, errors };
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// --- Routes -----------------------------------------------------------------

// GET /api/events?start=<iso>&end=<iso>
// Returns all events overlapping the [start, end) range.
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = await getDb();

    let result;
    if (start && end) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ error: 'start and end must be valid datetimes' });
      }
      // Overlap test: event starts before range end AND event ends after range start.
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         WHERE start_at < $2 AND end_at > $1
         ORDER BY start_at ASC, id ASC`,
        [startDate.toISOString(), endDate.toISOString()]
      );
    } else {
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events ORDER BY start_at ASC, id ASC`
      );
    }

    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const { title, start, end, errors } = parseEventBody(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, start.toISOString(), end.toISOString()]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

    const { title, start, end, errors } = parseEventBody(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start.toISOString(), end.toISOString(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Serve built frontend in production (optional, harmless in dev).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
