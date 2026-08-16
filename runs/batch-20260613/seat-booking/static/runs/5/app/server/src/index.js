/**
 * Entry point – creates the Express app, initialises PGLite, mounts routes,
 * and starts the background expiry worker.
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startExpiryWorker } from './expiry.js';
import apiRouter from './routes.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // ── database ──────────────────────────────────────────────────────────────
  await initDb();

  // ── express ───────────────────────────────────────────────────────────────
  const app = express();

  app.use(
    cors({
      origin: true,          // reflect the request origin (dev convenience)
      credentials: true,
    })
  );
  app.use(express.json());

  // ── routes ────────────────────────────────────────────────────────────────
  app.use('/api', apiRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ── start ─────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // ── background expiry sweep ───────────────────────────────────────────────
  startExpiryWorker();
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
