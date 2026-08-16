import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const PORT = process.env.PORT || 3001;

const db = new PGlite(DATA_DIR);

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validation helper: returns { ok, error, title, start, end }
function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body required' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { ok: false, error: 'Title must be non-empty' };
  }
  const start = new Date(body.start_at);
  const end = new Date(body.end_at);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { ok: false, error: 'start_at and end_at must be valid dates' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'end_at must be after start_at' };
  }
  return { ok: true, title, start, end };
}

const app = express();
app.use(cors());
app.use(express.json());

// GET /api/events?start=<iso>&end=<iso>
// Returns all events overlapping the requested range.
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    let result;
    if (start && end) {
      const s = new Date(start);
      const e = new Date(end);
      if (isNaN(s.getTime()) || isNaN(e.getTime())) {
        return res.status(400).json({ error: 'Invalid start or end query param' });
      }
      // Overlap condition: event.start < range.end AND event.end > range.start
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         WHERE start_at < $1 AND end_at > $2
         ORDER BY start_at ASC`,
        [e.toISOString(), s.toISOString()]
      );
    } else {
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events ORDER BY start_at ASC`
      );
    }
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const v = validateBody(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: v.error });
  }
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [v.title, v.start.toISOString(), v.end.toISOString()]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const v = validateBody(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: v.error });
  }
  try {
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [v.title, v.start.toISOString(), v.end.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function maybeSeed() {
  if (process.env.SEED !== '1') return;
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM events');
  if (rows[0].n > 0) return;
  // Seed against the current week (Monday-based) for visual verification.
  const now = new Date();
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const monday = d;
  const at = (dayOffset, h, m) => {
    const x = new Date(monday);
    x.setDate(x.getDate() + dayOffset);
    x.setHours(h, m, 0, 0);
    return x.toISOString();
  };
  const seed = [
    // Mon: three identical 09:00-10:00 -> three equal columns
    ['A 9-10', at(0, 9, 0), at(0, 10, 0)],
    ['B 9-10', at(0, 9, 0), at(0, 10, 0)],
    ['C 9-10', at(0, 9, 0), at(0, 10, 0)],
    // Mon later, non-overlapping -> full width
    ['Lunch', at(0, 12, 0), at(0, 13, 0)],
    // Tue: partial overlap chain
    ['Chain 1', at(1, 9, 0), at(1, 11, 0)],
    ['Chain 2', at(1, 10, 0), at(1, 12, 0)],
    ['Chain 3', at(1, 11, 30), at(1, 13, 0)],
    // Wed: minute precision 09:00-10:30
    ['Standup', at(2, 9, 0), at(2, 10, 30)],
    // Thu: event ending at 24:00
    ['Late night', at(3, 22, 0), at(4, 0, 0)],
  ];
  for (const [title, s, e] of seed) {
    await db.query(
      'INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)',
      [title, s, e]
    );
  }
  console.log('Seeded sample events.');
}

initDb()
  .then(maybeSeed)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
