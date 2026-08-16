import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';

const PORT = process.env.PORT || 3001;

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    // start_at / end_at come back as Date objects from PGlite; emit ISO.
    start_at: new Date(row.start_at).toISOString(),
    end_at: new Date(row.end_at).toISOString(),
  };
}

// Validate / normalize input for create & update.
// Returns { ok: true, value } or { ok: false, error }.
function parseEventInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length === 0) {
    return { ok: false, error: 'Title must be a non-empty string.' };
  }

  const start = new Date(body.start_at);
  const end = new Date(body.end_at);

  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: 'start_at must be a valid date/time.' };
  }
  if (Number.isNaN(end.getTime())) {
    return { ok: false, error: 'end_at must be a valid date/time.' };
  }
  if (end.getTime() <= start.getTime()) {
    return { ok: false, error: 'end_at must be after start_at.' };
  }

  return {
    ok: true,
    value: { title, start_at: start.toISOString(), end_at: end.toISOString() },
  };
}

async function main() {
  const db = await getDb();
  const app = express();

  app.use(cors());
  app.use(express.json());

  // GET /api/events?start=<iso>&end=<iso>
  // Returns events overlapping the [start, end) range.
  app.get('/api/events', async (req, res) => {
    const { start, end } = req.query;

    let rows;
    try {
      if (start && end) {
        const startDate = new Date(String(start));
        const endDate = new Date(String(end));
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
          return res.status(400).json({ error: 'start and end must be valid dates.' });
        }
        // Overlap: event.start < range.end AND event.end > range.start
        const result = await db.query(
          `SELECT id, title, start_at, end_at
             FROM events
            WHERE start_at < $1 AND end_at > $2
            ORDER BY start_at ASC, id ASC`,
          [endDate.toISOString(), startDate.toISOString()]
        );
        rows = result.rows;
      } else {
        const result = await db.query(
          `SELECT id, title, start_at, end_at
             FROM events
            ORDER BY start_at ASC, id ASC`
        );
        rows = result.rows;
      }
      res.json(rows.map(serializeEvent));
    } catch (err) {
      console.error('GET /api/events failed:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // POST /api/events
  app.post('/api/events', async (req, res) => {
    const parsed = parseEventInput(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const result = await db.query(
        `INSERT INTO events (title, start_at, end_at)
         VALUES ($1, $2, $3)
         RETURNING id, title, start_at, end_at`,
        [parsed.value.title, parsed.value.start_at, parsed.value.end_at]
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
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid event id.' });
    }
    const parsed = parseEventInput(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const result = await db.query(
        `UPDATE events
            SET title = $1, start_at = $2, end_at = $3
          WHERE id = $4
        RETURNING id, title, start_at, end_at`,
        [parsed.value.title, parsed.value.start_at, parsed.value.end_at, id]
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
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid event id.' });
    }
    try {
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

  app.listen(PORT, () => {
    console.log(`Calendar API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
