import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { addClient } from './sse.js';
import {
  getAllSeats,
  holdSeats,
  confirmHold,
  releaseHold,
  expireStaleHolds,
  getInventory
} from './booking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

let db;

// Initialize database
async function init() {
  db = await getDb();
  console.log('Database initialized');

  // Periodic sweep for expired holds (every 5 seconds)
  setInterval(async () => {
    try {
      await expireStaleHolds(db);
    } catch (e) {
      console.error('Sweep error:', e);
    }
  }, 5000);
}

// ======== API Routes ========

// GET /api/seats — return all seats with effective status
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getAllSeats(db);
    res.json({ seats });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/inventory — return inventory summary
app.get('/api/inventory', async (req, res) => {
  try {
    const inventory = await getInventory(db);
    res.json(inventory);
  } catch (err) {
    console.error('GET /api/inventory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds — hold seats
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;
    const result = await holdSeats(db, seatIds, sessionId);
    res.status(201).json(result);
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({
        error: err.message,
        conflictingSeatIds: err.conflictingSeatIds,
        missingIds: err.missingIds
      });
    } else {
      console.error('POST /api/holds error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// POST /api/holds/:holdId/confirm — confirm a hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const { sessionId } = req.body || {};
    const result = await confirmHold(db, holdId, sessionId);
    res.json(result);
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
    } else {
      console.error('POST /api/holds/:holdId/confirm error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// DELETE /api/holds/:holdId — release a hold
app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.query.sessionId || req.body?.sessionId;
    const result = await releaseHold(db, holdId, sessionId);
    res.json(result);
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
    } else {
      console.error('DELETE /api/holds/:holdId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// GET /api/stream — SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  // Send a heartbeat every 15 seconds
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });

  addClient(res);
});

// SPA fallback for frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

// Start server
init().then(() => {
  app.listen(PORT, () => {
    console.log(`Seat booking server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});

export default app;
