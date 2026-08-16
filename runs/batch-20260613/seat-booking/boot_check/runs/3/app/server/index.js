import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startExpiryLoop } from './expiry.js';
import { broadcast } from './sse.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialize database
  const db = await initDb();

  const app = express();

  // Middleware
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // Routes
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Start periodic expiry sweep (every 5 seconds)
  startExpiryLoop(db, broadcast, 5000);

  app.listen(PORT, () => {
    console.log(`[server] Seat booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
