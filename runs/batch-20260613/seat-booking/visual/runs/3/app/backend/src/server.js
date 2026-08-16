import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, sweepExpiredHolds } from './db.js';
import { broadcastSeatUpdate, heartbeat } from './sse.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Routes
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend static files
const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Initialize DB and start server
async function start() {
  try {
    const db = await initDb();
    console.log('[Server] Database initialized');

    // Periodic sweep: release expired holds every 5 seconds
    setInterval(async () => {
      try {
        const releasedIds = await sweepExpiredHolds(db);
        if (releasedIds.length > 0) {
          const releasedSeats = releasedIds.map(id => ({ id, status: 'available' }));
          broadcastSeatUpdate('released', releasedSeats);
          console.log(`[Sweep] Released ${releasedIds.length} expired hold(s): ${releasedIds.join(', ')}`);
        }
      } catch (err) {
        console.error('[Sweep] Error during expiry sweep:', err);
      }
    }, 5000);

    // Heartbeat every 20 seconds to keep SSE connections alive
    setInterval(() => {
      heartbeat();
    }, 20000);

    app.listen(PORT, () => {
      console.log(`[Server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
