import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import {
  validateEventInput,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './events.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// GET /api/events?start=<iso>&end=<iso>
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (typeof start !== 'string' || typeof end !== 'string') {
    return res.status(400).json({ error: 'start and end query params are required' });
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'start and end must be valid ISO dates' });
  }
  try {
    const events = await listEvents(startDate.toISOString(), endDate.toISOString());
    res.json(events);
  } catch (err) {
    console.error('GET /api/events failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  const result = validateEventInput(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  try {
    const event = await createEvent(result.value);
    res.status(201).json(event);
  } catch (err) {
    console.error('POST /api/events failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const result = validateEventInput(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  try {
    const event = await updateEvent(id, result.value);
    if (!event) return res.status(404).json({ error: 'event not found' });
    res.json(event);
  } catch (err) {
    console.error('PUT /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    const ok = await deleteEvent(id);
    if (!ok) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/events/:id failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

async function main() {
  await getDb(); // ensure schema is initialized before serving
  app.listen(PORT, () => {
    console.log(`Week calendar API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});

export { app };
