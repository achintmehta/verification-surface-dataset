const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'pgdata'));

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
      { title: 'Event 1', start_at: '2026-06-15T09:00:00Z', end_at: '2026-06-15T11:00:00Z' },
      { title: 'Event 2', start_at: '2026-06-15T10:00:00Z', end_at: '2026-06-15T12:00:00Z' },
      { title: 'Event 3', start_at: '2026-06-15T11:30:00Z', end_at: '2026-06-15T13:00:00Z' },
      { title: 'Event 4', start_at: '2026-06-15T14:00:00Z', end_at: '2026-06-15T15:00:00Z' },
      { title: 'Event 5', start_at: '2026-06-16T09:00:00Z', end_at: '2026-06-16T10:00:00Z' },
      { title: 'Event 6', start_at: '2026-06-16T09:00:00Z', end_at: '2026-06-16T10:00:00Z' },
      { title: 'Event 7', start_at: '2026-06-16T09:00:00Z', end_at: '2026-06-16T10:00:00Z' },
      { title: 'Event 8', start_at: '2026-06-17T22:00:00Z', end_at: '2026-06-18T02:00:00Z' }
    ];
    for (const e of events) {
      await db.query(
        `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)`,
        [e.title, new Date(e.start_at), new Date(e.end_at)]
      );
    }
  }
}

initDb().catch(console.error);

app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required' });
    }
    
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events 
       WHERE start_at < $1 AND end_at > $2`,
      [new Date(end), new Date(start)]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { title, start_at, end_at } = req.body;
    if (!title || title.trim() === '') {
      return res.status(400).json({ error: 'title is required' });
    }
    if (new Date(end_at) <= new Date(start_at)) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3) RETURNING *`,
      [title, new Date(start_at), new Date(end_at)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, start_at, end_at } = req.body;
    if (!title || title.trim() === '') {
      return res.status(400).json({ error: 'title is required' });
    }
    if (new Date(end_at) <= new Date(start_at)) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4 RETURNING *`,
      [title, new Date(start_at), new Date(end_at), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING *`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
