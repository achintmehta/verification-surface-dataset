import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '..', 'pgdata');

const app = express();
app.use(cors());
app.use(express.json());

let db;

async function initDB() {
  db = new PGlite(DB_PATH);
  
  // Store wall-clock times as TEXT in ISO format (no timezone)
  // Lexicographic comparison on ISO format works correctly for date ranges
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (title <> ''),
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL
    );
  `);
  
  console.log('Database initialized');
}

// GET /api/events?start=<iso>&end=<iso>
// start/end are ISO date strings like "2026-06-15T00:00:00"
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required' });
    }
    
    // Events overlapping the requested range: event.start_at < range.end AND event.end_at > range.start
    // Since we store as text in ISO format, lexicographic comparison works
    const result = await db.query(
      `SELECT id, title, start_at, end_at FROM events 
       WHERE start_at < $1 AND end_at > $2
       ORDER BY start_at, end_at`,
      [end, start]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const { title, start_at, end_at } = req.body;
    
    // Validate
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required and must be non-empty' });
    }
    if (!start_at || !end_at) {
      return res.status(400).json({ error: 'start_at and end_at are required' });
    }
    
    // Validate dates
    if (start_at >= end_at) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3) RETURNING id, title, start_at, end_at`,
      [title.trim(), start_at, end_at]
    );
    
    res.status(201).json(result.rows[0]);
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
    
    if (start_at >= end_at) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }
    
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4 RETURNING id, title, start_at, end_at`,
      [title.trim(), start_at, end_at, parseInt(id)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/events error:', err);
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
    console.error('DELETE /api/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
