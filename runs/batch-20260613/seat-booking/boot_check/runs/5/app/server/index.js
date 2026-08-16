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
  console.log('[server] Initializing database...');
  await initDb();
  console.log('[server] Database ready.');

  const app = express();

  // Middleware
  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
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

  // Start the expiry sweep
  startExpirySweep(5000);

  // Start listening
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
