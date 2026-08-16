import express from 'express';
import cors from 'cors';
import { getDb, releaseExpiredHolds } from './db.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// SSE clients
let sseClients = new Set();

function broadcastSeatUpdate(seatIds, status, extra = {}) {
  const data = JSON.stringify({ seatIds, status, ...extra, timestamp: Date.now() });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

async function ensureNoExpiredHolds(db) {
  const released = await releaseExpiredHolds(db);
  if (released.length > 0) {
    broadcastSeatUpdate(released, 'available');
  }
  return released;
}

app.get('/api/seats', async (req, res) => {
  try {
    const db = await getDb();
    await ensureNoExpiredHolds(db);
    
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by 
      FROM seats 
      ORDER BY row_label, seat_number
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  try {
    const db = await getDb();
    
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min TTL
    
    // Use transaction for atomicity
    const result = await db.transaction(async (tx) => {
      await ensureNoExpiredHolds(tx);
      
      // Check all seats are available
      const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      const checkResult = await tx.query(
        `SELECT id, status, hold_expires_at FROM seats WHERE id IN (${placeholders})`,
        seatIds
      );
      
      const unavailable = [];
      for (const seat of checkResult.rows) {
        if (seat.status !== 'available') {
          unavailable.push(seat.id);
        }
      }
      
      if (unavailable.length > 0) {
        return { success: false, unavailable };
      }
      
      // Acquire all seats
      const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
      await tx.query(
        `UPDATE seats 
         SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
         WHERE id IN (${updatePlaceholders})`,
        [...seatIds, holdId, expiresAt]
      );
      
      return { success: true, holdId, expiresAt };
    });
    
    if (!result.success) {
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflictingSeats: result.unavailable 
      });
    }
    
    broadcastSeatUpdate(seatIds, 'held', { holdId, sessionId, expiresAt });
    
    res.json({ holdId, expiresAt, seatIds });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }
  
  try {
    const db = await getDb();
    
    const result = await db.transaction(async (tx) => {
      await ensureNoExpiredHolds(tx);
      
      // Check hold validity
      const holdResult = await tx.query(
        `SELECT hold_id, status, hold_expires_at FROM seats WHERE hold_id = $1 LIMIT 1`,
        [holdId]
      );
      
      if (holdResult.rows.length === 0) {
        // Check if already booked by this hold (idempotency)
        const bookedResult = await tx.query(
          `SELECT id FROM seats WHERE booked_by = $1 LIMIT 1`,
          [holdId]
        );
        if (bookedResult.rows.length > 0) {
          return { success: true, alreadyBooked: true };
        }
        return { success: false, error: 'Hold not found' };
      }
      
      const seat = holdResult.rows[0];
      if (seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) {
        return { success: false, error: 'Hold expired' };
      }
      
      // Get all seats for this hold
      const seatsResult = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1`,
        [holdId]
      );
      const seatIds = seatsResult.rows.map(r => r.id);
      
      // Book them
      await tx.query(
        `UPDATE seats 
         SET status = 'booked', booked_by = $1, hold_id = NULL, hold_expires_at = NULL 
         WHERE hold_id = $1`,
        [holdId]
      );
      
      return { success: true, seatIds };
    });
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    if (result.alreadyBooked) {
      return res.json({ success: true, message: 'Already booked' });
    }
    
    broadcastSeatUpdate(result.seatIds, 'booked', { holdId });
    
    res.json({ success: true, seatIds: result.seatIds });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  
  try {
    const db = await getDb();
    
    const result = await db.transaction(async (tx) => {
      const seatsResult = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1`,
        [holdId]
      );
      
      if (seatsResult.rows.length === 0) {
        return { success: false };
      }
      
      const seatIds = seatsResult.rows.map(r => r.id);
      
      await tx.query(
        `UPDATE seats 
         SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
         WHERE hold_id = $1`,
        [holdId]
      );
      
      return { success: true, seatIds };
    });
    
    if (result.success) {
      broadcastSeatUpdate(result.seatIds, 'available');
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Hold not found' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  sseClients.add(res);
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Periodic sweep for expired holds
setInterval(async () => {
  try {
    const db = await getDb();
    const released = await releaseExpiredHolds(db);
    if (released.length > 0) {
      console.log('Released expired holds:', released);
      broadcastSeatUpdate(released, 'available');
    }
  } catch (e) {
    console.error('Sweep error:', e);
  }
}, 30000); // every 30 seconds

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
