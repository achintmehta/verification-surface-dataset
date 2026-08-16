import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

function validateInput(body) {
  const errors = [];
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('title must be a non-empty string');

  const start = new Date(body.start_at);
  const end = new Date(body.end_at);
  if (isNaN(start.getTime())) errors.push('start_at must be a valid date');
  if (isNaN(end.getTime())) errors.push('end_at must be a valid date');
  if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && !(end > start)) {
    errors.push('end_at must be after start_at');
  }
  return { errors, title, start, end };
}

// GET events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = await getDb();
    let result;
    if (start && end) {
      // overlap: start_at < range_end AND end_at > range_start
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         WHERE start_at < $1 AND end_at > $2
         ORDER BY start_at ASC`,
        [end, start]
      );
    } else {
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events ORDER BY start_at ASC`
      );
    }
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/events', async (req, res) => {
  const { errors, title, start, end } = validateInput(req.body || {});
  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }
  try {
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

app.put('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const { errors, title, start, end } = validateInput(req.body || {});
  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [title, start.toISOString(), end.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const db = await getDb();
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Serve the built frontend when available (production / preview).
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar server listening on http://localhost:${PORT}`);
  });
});
