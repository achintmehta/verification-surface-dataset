const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
const db = new PGlite(dbPath);

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);
  
  const res = await db.query('SELECT count(*) FROM events');
  if (res.rows[0].count === '0' || res.rows[0].count === 0) {
    const events = [
      { title: 'Event 1', start_at: '2026-06-15T09:00:00Z', end_at: '2026-06-15T10:30:00Z' },
      { title: 'Event 2', start_at: '2026-06-15T10:00:00Z', end_at: '2026-06-15T11:30:00Z' },
      { title: 'Event 3', start_at: '2026-06-15T11:00:00Z', end_at: '2026-06-15T12:30:00Z' },
      { title: 'Event 4', start_at: '2026-06-16T14:00:00Z', end_at: '2026-06-16T16:00:00Z' },
      { title: 'Event 5', start_at: '2026-06-16T14:30:00Z', end_at: '2026-06-16T15:30:00Z' },
      { title: 'Event 6', start_at: '2026-06-16T15:00:00Z', end_at: '2026-06-16T17:00:00Z' },
      { title: 'Event 7', start_at: '2026-06-17T08:00:00Z', end_at: '2026-06-17T09:00:00Z' },
      { title: 'Event 8', start_at: '2026-06-17T08:00:00Z', end_at: '2026-06-17T09:00:00Z' },
      { title: 'Event 9', start_at: '2026-06-17T08:00:00Z', end_at: '2026-06-17T09:00:00Z' },
      { title: 'Event 10', start_at: '2026-06-18T23:00:00Z', end_at: '2026-06-19T01:00:00Z' }
    ];
    for (const ev of events) {
      await db.query(
        `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)`,
        [ev.title, ev.start_at, ev.end_at]
      );
    }
  }
}

initDb().catch(console.error);

app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query parameters are required' });
  }
  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events 
       WHERE start_at < $2 AND end_at > $1`,
      [start, end]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }
  if (new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3) RETURNING *`,
      [title, start_at, end_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, start_at, end_at } = req.body;
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }
  if (new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }
  try {
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4 RETURNING *`,
      [title, start_at, end_at, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING *`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
