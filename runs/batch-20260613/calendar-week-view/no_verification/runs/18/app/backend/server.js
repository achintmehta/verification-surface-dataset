const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required' });
    }
    
    const result = await db.query(
      `SELECT id, title, start_at, end_at 
       FROM events 
       WHERE start_at < $2 AND end_at > $1`,
      [start, end]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { title, start_at, end_at } = req.body;
    if (!title || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (new Date(end_at) <= new Date(start_at)) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }

    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at) 
       VALUES ($1, $2, $3) RETURNING *`,
      [title.trim(), start_at, end_at]
    );
    res.status(201).json(result.rows[0]);
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
      return res.status(400).json({ error: 'Title is required' });
    }
    if (new Date(end_at) <= new Date(start_at)) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }

    const result = await db.query(
      `UPDATE events 
       SET title = $1, start_at = $2, end_at = $3 
       WHERE id = $4 RETURNING *`,
      [title.trim(), start_at, end_at, id]
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
    const result = await db.query(
      `DELETE FROM events WHERE id = $1 RETURNING *`,
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

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Backend listening on port \${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
