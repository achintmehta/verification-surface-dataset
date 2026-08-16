import { Router } from 'express';

export function createRouter(db) {
  const router = Router();

  // GET /api/events?start=<iso>&end=<iso>
  router.get('/events', async (req, res) => {
    try {
      const { start, end } = req.query;
      if (!start || !end) {
        return res.status(400).json({ error: 'start and end query params required' });
      }

      const result = await db.query(
        `SELECT id, title,
                to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') as start_at,
                to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') as end_at
         FROM events
         WHERE start_at < $2 AND end_at > $1
         ORDER BY start_at, end_at`,
        [start, end]
      );

      res.json(result.rows);
    } catch (err) {
      console.error('GET /events error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/events
  router.post('/events', async (req, res) => {
    try {
      const { title, start_at, end_at } = req.body;

      // Validation
      if (!title || typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({ error: 'Title must be a non-empty string' });
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
        `INSERT INTO events (title, start_at, end_at)
         VALUES ($1, $2, $3)
         RETURNING id, title,
                   to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') as start_at,
                   to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') as end_at`,
        [title.trim(), start_at, end_at]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('POST /events error:', err);
      if (err.message && err.message.includes('violates check constraint')) {
        return res.status(400).json({ error: 'Invalid event data' });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/events/:id
  router.put('/events/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { title, start_at, end_at } = req.body;

      if (!title || typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({ error: 'Title must be a non-empty string' });
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
        `UPDATE events SET title = $1, start_at = $2, end_at = $3
         WHERE id = $4
         RETURNING id, title,
                   to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS') as start_at,
                   to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS') as end_at`,
        [title.trim(), start_at, end_at, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('PUT /events error:', err);
      if (err.message && err.message.includes('violates check constraint')) {
        return res.status(400).json({ error: 'Invalid event data' });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/events/:id
  router.delete('/events/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const result = await db.query(
        'DELETE FROM events WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /events error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
