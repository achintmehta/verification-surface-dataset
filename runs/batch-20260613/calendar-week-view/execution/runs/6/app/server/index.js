import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const dbDir = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'pglite-data');
const db = new PGlite(dbDir);

function isValidDate(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime());
}

function toDbTimestamp(value) {
  return new Date(value).toISOString();
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CHECK (end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS idx_events_range ON events (start_at, end_at);
  `);
  await db.exec(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'events' AND column_name = 'start_at' AND data_type = 'timestamp without time zone'
      ) THEN
        ALTER TABLE events
          ALTER COLUMN start_at TYPE TIMESTAMPTZ USING start_at AT TIME ZONE current_setting('TimeZone'),
          ALTER COLUMN end_at TYPE TIMESTAMPTZ USING end_at AT TIME ZONE current_setting('TimeZone');
      END IF;
    END $$;
  `);
}

function validateEventBody(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const start = body.start_at ?? body.start;
  const end = body.end_at ?? body.end;
  if (!title) return { error: 'Title is required.' };
  if (!isValidDate(start) || !isValidDate(end)) return { error: 'Valid start_at and end_at are required.' };
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (endDate <= startDate) return { error: 'end_at must be after start_at.' };
  return { title, start_at: toDbTimestamp(startDate), end_at: toDbTimestamp(endDate) };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/events', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end) || new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required.' });
    }
    const result = await db.query(
      `SELECT id, title, start_at, end_at
       FROM events
       WHERE start_at < $1::timestamptz AND end_at > $2::timestamptz
       ORDER BY start_at ASC, end_at ASC, id ASC`,
      [toDbTimestamp(end), toDbTimestamp(start)]
    );
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
  try {
    const valid = validateEventBody(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2::timestamptz, $3::timestamptz)
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start_at, valid.end_at]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
    const valid = validateEventBody(req.body);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const result = await db.query(
      `UPDATE events
       SET title = $1, start_at = $2::timestamptz, end_at = $3::timestamptz
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [valid.title, valid.start_at, valid.end_at, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json(rowToEvent(result.rows[0]));
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
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

await initDb();
app.listen(port, () => {
  console.log(`Week calendar API listening on http://localhost:${port}`);
  console.log(`PGLite data directory: ${dbDir}`);
});
