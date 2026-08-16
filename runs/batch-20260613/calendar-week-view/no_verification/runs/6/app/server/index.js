import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite');

const db = new PGlite(DATA_DIR);

await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    CHECK (end_at > start_at)
  );
  CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at);
`);

const app = express();
app.use(cors());
app.use(express.json());

function parseDateInput(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeTimestamp(value) {
  // Store and compare local timestamp strings without a timezone suffix. The app is
  // intentionally single-user/local-time only, and the browser sends this format.
  if (typeof value !== 'string') return value;
  return value.replace('Z', '').replace(/\.\d{3}$/, '').slice(0, 19);
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: row.start_at instanceof Date ? toLocalInput(row.start_at) : String(row.start_at).replace(' ', 'T').slice(0, 19),
    end_at: row.end_at instanceof Date ? toLocalInput(row.end_at) : String(row.end_at).replace(' ', 'T').slice(0, 19)
  };
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function validateEventBody(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const startRaw = body?.start_at ?? body?.start;
  const endRaw = body?.end_at ?? body?.end;
  const start = parseDateInput(startRaw);
  const end = parseDateInput(endRaw);
  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at are required.' };
  if (end <= start) return { error: 'end_at must be after start_at.' };
  return {
    value: {
      title,
      start_at: normalizeTimestamp(startRaw),
      end_at: normalizeTimestamp(endRaw)
    }
  };
}

app.get('/api/events', async (req, res) => {
  const start = parseDateInput(req.query.start);
  const end = parseDateInput(req.query.end);
  if (!start || !end || end <= start) {
    return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
  }

  const result = await db.query(
    `SELECT id, title, start_at, end_at
       FROM events
      WHERE start_at < $1::timestamp AND end_at > $2::timestamp
      ORDER BY start_at, end_at, title`,
    [normalizeTimestamp(req.query.end), normalizeTimestamp(req.query.start)]
  );
  res.json(result.rows.map(rowToEvent));
});

app.post('/api/events', async (req, res) => {
  const validation = validateEventBody(req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });

  const id = randomUUID();
  try {
    const result = await db.query(
      `INSERT INTO events (id, title, start_at, end_at)
       VALUES ($1, $2, $3::timestamp, $4::timestamp)
       RETURNING id, title, start_at, end_at`,
      [id, validation.value.title, validation.value.start_at, validation.value.end_at]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const validation = validateEventBody(req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });

  try {
    const result = await db.query(
      `UPDATE events
          SET title = $2,
              start_at = $3::timestamp,
              end_at = $4::timestamp
        WHERE id = $1
        RETURNING id, title, start_at, end_at`,
      [req.params.id, validation.value.title, validation.value.start_at, validation.value.end_at]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
  res.status(204).end();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Week calendar API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
