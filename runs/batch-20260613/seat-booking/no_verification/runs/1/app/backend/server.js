import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialise database (creates tables + seeds seats)
  await initDb();

  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ── Start ───────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // Start background expiry sweep (every 5 s)
  startExpirySweep(5_000);
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
