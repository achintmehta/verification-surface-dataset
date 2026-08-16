import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { addClient } from './sse.js';
import {
  getAllSeats,
  holdSeats,
  confirmHold,
  releaseHold,
  getInventory,
  startSweepTimer,
  HOLD_TTL_SECONDS,
} from './seats.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/seats – list all seats with effective status
app.get('/api/seats', async (_req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats, holdTtlSeconds: HOLD_TTL_SECONDS });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/inventory – exact counts
app.get('/api/inventory', async (_req, res) => {
  try {
    const inventory = await getInventory();
    res.json(inventory);
  } catch (err) {
    console.error('GET /api/inventory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds – request a hold on one or more seats
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      res.status(400).json({ error: 'seatIds must be a non-empty array' });
      return;
    }
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    // Validate seatIds are numbers
    const numericSeatIds = seatIds.map(Number);
    if (numericSeatIds.some(isNaN)) {
      res.status(400).json({ error: 'All seatIds must be numbers' });
      return;
    }

    const result = await holdSeats(numericSeatIds, sessionId);

    if (!result.ok) {
      res.status(409).json({ error: 'Seats unavailable', conflicting: result.conflicting });
      return;
    }

    res.status(201).json(result.hold);
  } catch (err) {
    console.error('POST /api/holds error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/holds/:holdId/confirm – confirm a hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await confirmHold(holdId);

    if (!result.ok) {
      const status = result.reason === 'Hold not found' ? 404 : 410;
      res.status(status).json({ error: result.reason });
      return;
    }

    res.json(result.booking);
  } catch (err) {
    console.error('POST /api/holds/:holdId/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/holds/:holdId – release a hold early
app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);

    if (!result.ok) {
      const status = result.reason === 'Hold not found' ? 404 : 409;
      res.status(status).json({ error: result.reason });
      return;
    }

    res.json({ released: true, seats: result.seats });
  } catch (err) {
    console.error('DELETE /api/holds/:holdId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stream – SSE endpoint
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  // Ensure DB is initialized before accepting requests
  await getDb();
  console.log('Database initialized.');

  // Start the periodic expired-hold sweeper
  startSweepTimer();
  console.log('Expiry sweep timer started.');

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
