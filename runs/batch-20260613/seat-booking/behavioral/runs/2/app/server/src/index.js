import express from 'express';
import cors from 'cors';
import { getDb, initDb } from './db.js';
import { createRouter } from './routes.js';
import { sweepExpiredHolds } from './seats.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await getDb();
  await initDb(db);

  const app = express();

  app.use(cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }));
  app.use(express.json());

  app.use('/api', createRouter(db));

  // Periodic sweep for expired holds (every 5 seconds)
  const SWEEP_INTERVAL_MS = 5_000;
  const sweepTimer = setInterval(() => sweepExpiredHolds(db), SWEEP_INTERVAL_MS);
  sweepTimer.unref(); // Don't keep the process alive just for sweeps

  const server = app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    clearInterval(sweepTimer);
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    clearInterval(sweepTimer);
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
