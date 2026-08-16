import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { broadcast } from './sse.js';
import { startExpiryLoop } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialise database
  const db = await initDb();
  console.log('[server] Database ready.');

  const app = express();

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }));
  app.use(express.json());

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Start server ──────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // ── Periodic expiry sweep ─────────────────────────────────────────────────
  startExpiryLoop(db, broadcast, 5000);
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
