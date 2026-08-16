import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { sweepExpiredHolds } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;
const SWEEP_INTERVAL_MS = 10_000; // sweep every 10 seconds

async function main() {
  // Initialize database
  const db = await initDb();
  console.log('[db] PGLite initialized');

  const app = express();

  // Middleware
  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }));
  app.use(express.json());

  // Routes
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // Start background sweep for expired holds
  setInterval(() => sweepExpiredHolds(db), SWEEP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
