import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In production, serve the built frontend (if present) from the same origin.
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString()
  };
}

// Validate event input. Returns { valid, error, title, start, end }.
function validateInput(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { valid: false, error: 'title must be non-empty' };
  if (!isValidDate(body.start_at) || !isValidDate(body.end_at)) {
    return { valid: false, error: 'start_at and end_at must be valid ISO timestamps' };
  }
  const start = new Date(body.start_at);
  const end = new Date(body.end_at);
  if (!(end.getTime() > start.getTime())) {
    return { valid: false, error: 'end_at must be after start_at' };
  }
  return { valid: true, title, start: start.toISOString(), end: end.toISOString() };
}

// GET events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'start and end query params must be valid ISO timestamps' });
  }
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $2 AND end_at > $1
       ORDER BY start_at ASC`,
      [new Date(start).toISOString(), new Date(end).toISOString()]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/events', async (req, res) => {
  const v = validateInput(req.body || {});
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    const db = await getDb();
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [v.title, v.start, v.end]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const v = validateInput(req.body || {});
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    const db = await getDb();
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [v.title, v.start, v.end, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const db = await getDb();
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// SPA fallback for non-API routes.
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  const indexFile = path.join(distDir, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Calendar API listening on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to init DB', err);
  process.exit(1);
});
