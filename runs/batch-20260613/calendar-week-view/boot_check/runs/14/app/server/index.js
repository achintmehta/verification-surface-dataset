import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Database (embedded PGLite, persisted to local disk) -------------------

const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, 'data', 'pgdata');

let dbInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;

  // PGLite only creates the leaf data directory; ensure parents exist.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      title     TEXT NOT NULL,
      start_at  TIMESTAMPTZ NOT NULL,
      end_at    TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);

  dbInstance = db;
  return db;
}

// --- App -------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// --- Helpers ---------------------------------------------------------------

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function parseIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  return isValidDate(d) ? d : null;
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

/**
 * Validate and normalize an event payload.
 * Returns { ok: true, value } or { ok: false, error }.
 */
function validateEventBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title === '') {
    return { ok: false, error: 'Title must be a non-empty string.' };
  }

  const start = parseIso(body.start_at);
  if (!start) {
    return { ok: false, error: 'start_at must be a valid ISO date-time.' };
  }

  const end = parseIso(body.end_at);
  if (!end) {
    return { ok: false, error: 'end_at must be a valid ISO date-time.' };
  }

  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at.' };
  }

  return {
    ok: true,
    value: {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
}

// --- Routes ----------------------------------------------------------------

// GET /api/events?start=<iso>&end=<iso>
// Returns all events overlapping [start, end).
app.get('/api/events', async (req, res) => {
  const start = parseIso(req.query.start);
  const end = parseIso(req.query.end);

  if (!start || !end) {
    return res
      .status(400)
      .json({ error: 'start and end query params must be valid ISO date-times.' });
  }

  try {
    const db = await getDb();
    // Overlap: event.start < range.end AND event.end > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at
         FROM events
        WHERE start_at < $1 AND end_at > $2
        ORDER BY start_at ASC, id ASC`,
      [end.toISOString(), start.toISOString()]
    );
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const validated = validateEventBody(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  try {
    const db = await getDb();
    const { title, start_at, end_at } = validated.value;
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }

  const validated = validateEventBody(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  try {
    const db = await getDb();
    const { title, start_at, end_at } = validated.value;
    const result = await db.query(
      `UPDATE events
          SET title = $1, start_at = $2, end_at = $3
        WHERE id = $4
        RETURNING id, title, start_at, end_at`,
      [title, start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- Boot ------------------------------------------------------------------

async function main() {
  await getDb(); // ensure DB + schema ready before listening
  app.listen(PORT, () => {
    console.log(`Week-calendar API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
