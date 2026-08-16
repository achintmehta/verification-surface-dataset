const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// PGLite database persisted to local disk
const DB_PATH = path.join(__dirname, '..', 'pgdata');
let db;

async function initDB() {
  db = new PGlite(DB_PATH);

  // Check if the events table exists
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'events'
    ) as exists;
  `);

  if (tableCheck.rows[0].exists) {
    // Check if columns are TIMESTAMPTZ; if not, drop and recreate
    const colCheck = await db.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'events' AND column_name = 'start_at';
    `);
    if (colCheck.rows.length > 0 && colCheck.rows[0].data_type !== 'timestamp with time zone') {
      console.log('Migrating events table from TIMESTAMP to TIMESTAMPTZ...');
      await db.query(`DROP TABLE events;`);
    }
  }

  // Create the table with TIMESTAMPTZ
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (title <> ''),
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CHECK (end_at > start_at)
    );
  `);

  console.log('Database initialized');
}

/** Serialize a row's timestamp fields to ISO strings */
function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start_at: row.start_at instanceof Date ? row.start_at.toISOString() : new Date(row.start_at).toISOString(),
    end_at: row.end_at instanceof Date ? row.end_at.toISOString() : new Date(row.end_at).toISOString()
  };
}

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required' });
    }

    // Events overlapping the requested range: event.start_at < range.end AND event.end_at > range.start
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at, end_at`,
      [new Date(end).toISOString(), new Date(start).toISOString()]
    );

    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const { title, start_at, end_at } = req.body;

    // Validation
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required and must be non-empty' });
    }
    if (!start_at || !end_at) {
      return res.status(400).json({ error: 'start_at and end_at are required' });
    }

    const startDate = new Date(start_at);
    const endDate = new Date(end_at);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    if (endDate <= startDate) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }

    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3) RETURNING id, title, start_at, end_at`,
      [title.trim(), startDate.toISOString(), endDate.toISOString()]
    );

    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, start_at, end_at } = req.body;

    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required and must be non-empty' });
    }
    if (!start_at || !end_at) {
      return res.status(400).json({ error: 'start_at and end_at are required' });
    }

    const startDate = new Date(start_at);
    const endDate = new Date(end_at);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    if (endDate <= startDate) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }

    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4 RETURNING id, title, start_at, end_at`,
      [title.trim(), startDate.toISOString(), endDate.toISOString(), parseInt(id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [parseInt(id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
