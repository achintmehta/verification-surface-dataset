import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(process.env.PGLITE_DATA_DIR || path.join(rootDir, '.pglite-data'));

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS events_range_idx ON events (start_at, end_at)');
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateEventPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = parseDate(body.start_at ?? body.start);
  const end = parseDate(body.end_at ?? body.end);

  if (!title) return { error: 'Title is required.' };
  if (!start || !end) return { error: 'Valid start_at and end_at are required.' };
  if (end <= start) return { error: 'end_at must be after start_at.' };

  return { title, start_at: start.toISOString(), end_at: end.toISOString() };
}

function normalizeRow(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    if (!start || !end || end <= start) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }

    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $2 AND end_at > $1
       ORDER BY start_at, end_at, title`,
      [start.toISOString(), end.toISOString()],
    );
    res.json(result.rows.map(normalizeRow));
  } catch (error) {
    next(error);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const valid = validateEventPayload(req.body ?? {});
    if (valid.error) return res.status(400).json({ error: valid.error });

    const id = randomUUID();
    const result = await db.query(
      `INSERT INTO events (id, title, start_at, end_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, start_at, end_at`,
      [id, valid.title, valid.start_at, valid.end_at],
    );
    res.status(201).json(normalizeRow(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const valid = validateEventPayload(req.body ?? {});
    if (valid.error) return res.status(400).json({ error: valid.error });

    const result = await db.query(
      `UPDATE events
       SET title = $2, start_at = $3, end_at = $4
       WHERE id = $1
       RETURNING id, title, start_at, end_at`,
      [req.params.id, valid.title, valid.start_at, valid.end_at],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(normalizeRow(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const isCheckViolation = String(error?.message ?? '').includes('check constraint');
  res.status(isCheckViolation ? 400 : 500).json({ error: isCheckViolation ? 'Invalid event time range.' : 'Internal server error.' });
});

await initDb();
app.listen(port, () => {
  console.log(`Week calendar API listening on http://localhost:${port}`);
});
