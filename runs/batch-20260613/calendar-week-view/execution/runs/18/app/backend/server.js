import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (title <> ''),
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CHECK (end_at > start_at)
    );
  `);
}

initDb().catch(console.error);

app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query parameters are required' });
  }

  try {
    const result = await db.query(
      `SELECT id, title, start_at, end_at 
       FROM events 
       WHERE start_at < $2 AND end_at > $1`,
      [new Date(start), new Date(end)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start_at, end_at } = req.body;
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'title is required and cannot be empty' });
  }
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }
  if (new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) 
       VALUES ($1, $2, $3) 
       RETURNING id, title, start_at, end_at`,
      [title.trim(), new Date(start_at), new Date(end_at)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Invalid input' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { title, start_at, end_at } = req.body;
  
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'title is required and cannot be empty' });
  }
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at and end_at are required' });
  }
  if (new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: 'end_at must be after start_at' });
  }

  try {
    const result = await db.query(
      `UPDATE events 
       SET title = $1, start_at = $2, end_at = $3 
       WHERE id = $4 
       RETURNING id, title, start_at, end_at`,
      [title.trim(), new Date(start_at), new Date(end_at), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Invalid input' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
