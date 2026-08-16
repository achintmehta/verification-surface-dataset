/**
 * Main Express server entry point.
 */
import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialize database
  await initDb();

  const app = express();

  // Middleware
  app.use(cors({
    origin: true,
    credentials: true,
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

  // Start periodic expiry sweep (every 5 seconds)
  startExpirySweep(5000);

  app.listen(PORT, () => {
    console.log(`Seat booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
