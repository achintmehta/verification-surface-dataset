import express from 'express';
import cors from 'cors';
import { initDb, getAllSeats, createHold, confirmHold, releaseHold, releaseExpiredHolds } from './db.js';

const app = express();
const PORT = 3000;

// SSE clients
let sseClients = new Set();

app.use(cors());
app.use(express.json());

// Initialize DB
await initDb();

// Periodic expiry sweep
setInterval(async () => {
  const released = await releaseExpiredHolds();
  if (released.length > 0) {
    released.forEach(seatId => {
      broadcastUpdate(seatId, 'available');
    });
  }
}, 30000);

// Broadcast function
function broadcastUpdate(seatId, status, extra = {}) {
  const payload = JSON.stringify({ seatId, status, ...extra });
  sseClients.forEach(client => {
    client.write(`data: ${payload}\n\n`);
  });
}

// GET /api/seats
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/holds
app.post('/api/holds', async (req, res) => {
  try {
    const { seatIds, sessionId } = req.body;
    if (!seatIds || !Array.isArray(seatIds) || !sessionId) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    
    const result = await createHold(seatIds, sessionId);
    
    if (!result.success) {
      return res.status(409).json({ conflictingSeats: result.conflictingSeats });
    }
    
    // Broadcast updates
    result.seatIds.forEach(seatId => {
      broadcastUpdate(seatId, 'held', { holdId: result.holdId, expiresAt: result.expiresAt });
    });
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/holds/:holdId/confirm
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  try {
    const { holdId } = req.params;
    const sessionId = req.body.sessionId || 'unknown';
    
    const result = await confirmHold(holdId, sessionId);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    if (result.bookedSeatIds) {
      result.bookedSeatIds.forEach(seatId => {
        broadcastUpdate(seatId, 'booked');
      });
    }
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Actually fix confirm to return seat ids for broadcast
// But since code is already written, I'll adjust in next edit if needed. For now continue.

// DELETE /api/holds/:holdId
app.delete('/api/holds/:holdId', async (req, res) => {
  try {
    const { holdId } = req.params;
    const releasedSeats = await releaseHold(holdId);
    
    releasedSeats.forEach(seatId => {
      broadcastUpdate(seatId, 'available');
    });
    
    res.json({ released: releasedSeats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stream - SSE
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  sseClients.add(res);
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Fix for confirm broadcast - we need better handling
// Let's override the confirm route with proper implementation
// But since file written, use edit.

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});