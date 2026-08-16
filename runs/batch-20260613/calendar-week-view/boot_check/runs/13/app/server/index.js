'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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

// Validate a create/update body. Returns { error } or { title, startAt, endAt }.
function validateEventBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object.' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title === '') {
    return { error: 'Title must be a non-empty string.' };
  }
  const startAt = parseIso(body.start_at);
  const endAt = parseIso(body.end_at);
  if (!startAt) return { error: 'start_at must be a valid ISO timestamp.' };
  if (!endAt) return { error: 'end_at must be a valid ISO timestamp.' };
  if (!(endAt.getTime() > startAt.getTime())) {
    return { error: 'end_at must be after start_at.' };
  }
  return { title, startAt, endAt };
}

// --- API -------------------------------------------------------------------

// GET /api/events?start=<iso>&end=<iso> : events overlapping [start, end)
app.get('/api/events', async (req, res) => {
  const db = await getDb();
  const start = parseIso(req.query.start);
  const end = parseIso(req.query.end);

  try {
    let result;
    if (start && end) {
      // Overlap: event.start < range.end AND event.end > range.start
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         WHERE start_at < $1 AND end_at > $2
         ORDER BY start_at ASC, id ASC`,
        [end.toISOString(), start.toISOString()]
      );
    } else {
      result = await db.query(
        `SELECT id, title, start_at, end_at FROM events
         ORDER BY start_at ASC, id ASC`
      );
    }
    res.json(result.rows.map(serializeEvent));
  } catch (err) {
    console.error('GET /api/events failed:', err);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const parsed = validateEventBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const db = await getDb();
  try {
    const result = await db.query(
      `INSERT INTO events (title, start_at, end_at)
       VALUES ($1, $2, $3)
       RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.startAt.toISOString(), parsed.endAt.toISOString()]
    );
    res.status(201).json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('POST /api/events failed:', err);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }
  const parsed = validateEventBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const db = await getDb();
  try {
    const result = await db.query(
      `UPDATE events SET title = $1, start_at = $2, end_at = $3
       WHERE id = $4
       RETURNING id, title, start_at, end_at`,
      [parsed.title, parsed.startAt.toISOString(), parsed.endAt.toISOString(), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json(serializeEvent(result.rows[0]));
  } catch (err) {
    console.error('PUT /api/events/:id failed:', err);
    res.status(500).json({ error: 'Failed to update event.' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }
  const db = await getDb();
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
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

// --- Static frontend (production / single-process serving) -----------------
// Serve the built client if present, otherwise the raw client source so the
// app works from a single `node server/index.js` boot.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
const clientSrc = path.join(__dirname, '..', 'client');
const fs = require('fs');
const staticRoot = fs.existsSync(clientDist) ? clientDist : clientSrc;
app.use(express.static(staticRoot));

// Start server
function start() {
  return app.listen(PORT, () => {
    console.log(`Week-calendar server listening on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  // Eagerly initialize the DB, then start listening.
  getDb()
    .then(() => start())
    .catch((err) => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
}

module.exports = { app, start };
