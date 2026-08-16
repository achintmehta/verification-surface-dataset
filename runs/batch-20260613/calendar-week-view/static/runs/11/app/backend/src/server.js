import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import {
  validateEventInput,
  listEventsInRange,
  createEvent,
  updateEvent,
  deleteEvent,
} from './events.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

function isValidIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!isValidIso(start) || !isValidIso(end)) {
      return res
        .status(400)
        .json({ error: 'start and end query params must be valid ISO timestamps' });
    }
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    if (!(new Date(endIso).getTime() > new Date(startIso).getTime())) {
      return res.status(400).json({ error: 'end must be after start' });
    }
    const events = await listEventsInRange(startIso, endIso);
    res.json(events);
  } catch (err) {
    next(err);
  }
});

// POST /api/events
app.post('/api/events', async (req, res, next) => {
  try {
    const validation = validateEventInput(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const event = await createEvent(validation.value);
    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid event id' });
    }
    const validation = validateEventInput(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const event = await updateEvent(id, validation.value);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(event);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid event id' });
    }
    const deleted = await deleteEvent(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function main() {
  // Initialize DB (creates schema) before accepting traffic.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Week-calendar backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app };
