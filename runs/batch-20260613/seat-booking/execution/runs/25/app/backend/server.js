import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import {
  getAllSeats,
  holdSeats,
  confirmHold,
  releaseHold,
  getInventory,
  startExpirySweep
} from './seatService.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// GET /api/seats - Get all seats with effective status
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (error) {
    console.error('Error getting seats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/inventory - Get inventory counts
app.get('/api/inventory', async (req, res) => {
  try {
    const inventory = await getInventory();
    res.json(inventory);
  } catch (error) {
    console.error('Error getting inventory:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds - Create a hold on seats
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    // Ensure seatIds are integers
    const parsedSeatIds = seatIds.map(id => parseInt(id, 10));
    if (parsedSeatIds.some(id => isNaN(id))) {
      return res.status(400).json({ error: 'All seatIds must be valid numbers' });
    }

    const result = await holdSeats(parsedSeatIds, sessionId);

    if (!result.success) {
      const statusCode = result.status || 400;
      return res.status(statusCode).json({
        error: result.error,
        conflictingSeatIds: result.conflictingSeatIds,
        missingIds: result.missingIds
      });
    }

    res.status(201).json({
      hold: result.hold,
      seats: result.seats
    });
  } catch (error) {
    console.error('Error creating hold:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/holds/:holdId/confirm - Confirm a hold
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await confirmHold(holdId);

    if (!result.success) {
      const statusCode = result.status || 400;
      return res.status(statusCode).json({ error: result.error });
    }

    res.json({
      message: result.alreadyConfirmed ? 'Hold was already confirmed' : 'Hold confirmed successfully',
      alreadyConfirmed: result.alreadyConfirmed,
      seats: result.seats
    });
  } catch (error) {
    console.error('Error confirming hold:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/holds/:holdId - Release a hold
app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const result = await releaseHold(holdId);

    if (!result.success) {
      const statusCode = result.status || 400;
      return res.status(statusCode).json({ error: result.error });
    }

    res.json({
      message: 'Hold released successfully',
      seats: result.seats
    });
  } catch (error) {
    console.error('Error releasing hold:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stream - SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial connection message
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to seat updates' })}\n\n`);

  // Keep alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  addClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// Initialize database and start server
async function start() {
  try {
    await initDb();
    console.log('Database initialized');

    // Start periodic expiry sweep every 5 seconds
    startExpirySweep(5000);
    console.log('Expiry sweep started');

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
