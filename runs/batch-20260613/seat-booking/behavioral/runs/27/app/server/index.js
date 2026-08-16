import express from 'express';
import cors from 'cors';
import { initDb, getDb, releaseExpiredHolds, HOLD_TTL_MS } from './db.js';

const app = express();
const PORT = 3000;

// SSE clients
let sseClients = new Set();

app.use(cors());
app.use(express.json());

// Broadcast seat update to all SSE clients
function broadcastSeatUpdate(seat) {
  const data = JSON.stringify({ type: 'seat-update', seat });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

function broadcastSeatsUpdate(seats) {
  const data = JSON.stringify({ type: 'seats-update', seats });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Middleware to release expired holds before operations
async function releaseExpiredMiddleware(req, res, next) {
  try {
    const released = await releaseExpiredHolds();
    if (released.length > 0) {
      console.log(`Released ${released.length} expired holds`);
      // Broadcast releases
      for (const seat of released) {
        const updatedSeat = { ...seat, status: 'available' };
        broadcastSeatUpdate(updatedSeat);
      }
    }
  } catch (err) {
    console.error('Error releasing expired holds:', err);
  }
  next();
}

app.use(releaseExpiredMiddleware);

app.get('/api/seats', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);
    
    // Compute effective status (in case some expired slipped through)
    const seats = result.rows.map(row => {
      let effectiveStatus = row.status;
      if (row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date()) {
        effectiveStatus = 'available';
      }
      return {
        id: row.id,
        row_label: row.row_label,
        seat_number: row.seat_number,
        status: effectiveStatus,
        holdId: row.hold_id,
        expiresAt: row.hold_expires_at,
        bookedBy: row.booked_by
      };
    });
    
    res.json({ seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
    return res.status(400).json({ error: 'Invalid request: seatIds and sessionId required' });
  }
  
  const db = await getDb();
  const holdId = `hold-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();
  
  try {
    await db.exec('BEGIN');
    
    // Check all seats are available and lock them
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const checkQuery = `
      SELECT id, status, hold_expires_at 
      FROM seats 
      WHERE id IN (${placeholders})
      FOR UPDATE
    `;
    
    const checkResult = await db.query(checkQuery, seatIds);
    
    const conflictingSeats = [];
    for (const row of checkResult.rows) {
      const isExpired = row.status === 'held' && row.hold_expires_at && new Date(row.hold_expires_at) < new Date();
      if (row.status !== 'available' && !isExpired) {
        conflictingSeats.push(row.id);
      }
    }
    
    if (conflictingSeats.length > 0) {
      await db.exec('ROLLBACK');
      return res.status(409).json({ 
        error: 'Some seats are unavailable', 
        conflictingSeats 
      });
    }
    
    // All good, acquire them
    const updatePlaceholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const updateQuery = `
      UPDATE seats 
      SET status = 'held', hold_id = $${seatIds.length + 1}, hold_expires_at = $${seatIds.length + 2}
      WHERE id IN (${updatePlaceholders})
    `;
    
    await db.query(updateQuery, [...seatIds, holdId, expiresAt]);
    
    await db.exec('COMMIT');
    
    // Broadcast updates
    for (const seatId of seatIds) {
      const updatedSeat = {
        id: seatId,
        status: 'held',
        holdId,
        expiresAt
      };
      broadcastSeatUpdate(updatedSeat);
    }
    
    res.json({
      holdId,
      seatIds,
      expiresAt,
      sessionId
    });
    
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Hold error:', err);
    res.status(500).json({ error: 'Failed to create hold' });
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;
  
  const db = await getDb();
  
  try {
    await db.exec('BEGIN');
    
    // Find the hold's seats
    const holdResult = await db.query(`
      SELECT id, status, hold_id, hold_expires_at, booked_by
      FROM seats 
      WHERE hold_id = $1
      FOR UPDATE
    `, [holdId]);
    
    if (holdResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    const seats = holdResult.rows;
    const firstSeat = seats[0];
    
    // Check if already booked (idempotency)
    if (firstSeat.status === 'booked' && firstSeat.booked_by === sessionId) {
      await db.exec('COMMIT');
      return res.json({ 
        success: true, 
        message: 'Already confirmed', 
        seatIds: seats.map(s => s.id) 
      });
    }
    
    // Validate ownership and expiry
    const now = new Date();
    const isExpired = firstSeat.hold_expires_at && new Date(firstSeat.hold_expires_at) < now;
    
    if (isExpired) {
      await db.exec('ROLLBACK');
      return res.status(410).json({ error: 'Hold has expired', expired: true });
    }
    
    if (firstSeat.hold_id !== holdId) {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Invalid hold ownership' });
    }
    
    // Confirm: book the seats
    const seatIds = seats.map(s => s.id);
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    
    await db.query(`
      UPDATE seats 
      SET status = 'booked', hold_id = NULL, hold_expires_at = NULL, booked_by = $${seatIds.length + 1}
      WHERE id IN (${placeholders})
    `, [...seatIds, sessionId]);
    
    await db.exec('COMMIT');
    
    // Broadcast
    for (const seatId of seatIds) {
      broadcastSeatUpdate({
        id: seatId,
        status: 'booked',
        bookedBy: sessionId
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Booking confirmed', 
      seatIds 
    });
    
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm hold' });
  }
});

app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const db = await getDb();
  
  try {
    await db.exec('BEGIN');
    
    const result = await db.query(`
      UPDATE seats 
      SET status = 'available', hold_id = NULL, hold_expires_at = NULL
      WHERE hold_id = $1
      RETURNING id
    `, [holdId]);
    
    await db.exec('COMMIT');
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hold not found' });
    }
    
    // Broadcast releases
    for (const row of result.rows) {
      broadcastSeatUpdate({
        id: row.id,
        status: 'available'
      });
    }
    
    res.json({ success: true, released: result.rows.length });
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error('Release error:', err);
    res.status(500).json({ error: 'Failed to release hold' });
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
    const released = await releaseExpiredHolds();
    if (released.length > 0) {
      console.log(`Periodic sweep released ${released.length} holds`);
      for (const seat of released) {
        broadcastSeatUpdate({ ...seat, status: 'available' });
      }
    }
  } catch (err) {
    console.error('Sweep error:', err);
  }
}, 30000); // every 30 seconds

async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);