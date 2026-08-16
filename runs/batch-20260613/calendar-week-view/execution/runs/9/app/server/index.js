import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'data', 'pglite');
const port = Number(process.env.PORT || 3000);

function isValidDateString(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function getEventInput(body) {
  return {
    title: typeof body.title === 'string' ? body.title.trim() : '',
    start_at: body.start_at ?? body.start,
    end_at: body.end_at ?? body.end
  };
}

function validateEventInput(body) {
  const input = getEventInput(body || {});
  if (!input.title) return { ok: false, error: 'Title is required.' };
  if (!isValidDateString(input.start_at) || !isValidDateString(input.end_at)) {
    return { ok: false, error: 'Valid start_at and end_at timestamps are required.' };
  }
  if (new Date(input.end_at).getTime() <= new Date(input.start_at).getTime()) {
    return { ok: false, error: 'end_at must be after start_at.' };
  }
  return { ok: true, value: input };
}

function mapRows(result) {
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    start_at: row.start_at,
    end_at: row.end_at
  }));
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    );
  `);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/events', async (req, res, next) => {
    try {
      const { start, end } = req.query;
      if (!isValidDateString(start) || !isValidDateString(end) || new Date(end).getTime() <= new Date(start).getTime()) {
        return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
      }
      const result = await db.query(
        `SELECT id, title,
                to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at
           FROM events
          WHERE start_at < $2::timestamp AND end_at > $1::timestamp
          ORDER BY start_at, end_at, id`,
        [start, end]
      );
      res.json(mapRows(result));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/events', async (req, res, next) => {
    try {
      const validation = validateEventInput(req.body);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
      const { title, start_at, end_at } = validation.value;
      const result = await db.query(
        `INSERT INTO events (title, start_at, end_at)
         VALUES ($1, $2::timestamp, $3::timestamp)
         RETURNING id, title,
                   to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                   to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
        [title, start_at, end_at]
      );
      res.status(201).json(mapRows(result)[0]);
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/events/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
      const validation = validateEventInput(req.body);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
      const { title, start_at, end_at } = validation.value;
      const result = await db.query(
        `UPDATE events
            SET title = $1, start_at = $2::timestamp, end_at = $3::timestamp
          WHERE id = $4
          RETURNING id, title,
                    to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
                    to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at`,
        [title, start_at, end_at, id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
      res.json(mapRows(result)[0]);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/events/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
      const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  const distDir = path.join(rootDir, 'dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res, next) => {
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    if (err?.message?.includes('check constraint')) {
      return res.status(400).json({ error: 'end_at must be after start_at.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  app.listen(port, () => {
    console.log(`API server listening on http://localhost:${port}`);
    console.log(`PGLite data directory: ${dataDir}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
