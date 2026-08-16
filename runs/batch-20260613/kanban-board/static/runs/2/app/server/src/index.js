/**
 * Entry point for the Kanban board backend.
 * Initializes PGLite, mounts routes, and starts the Express server.
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { sseHandler } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialize database first
  await initDb();
  console.log('✅ PGLite database ready');

  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────
  app.get('/api/stream', sseHandler);
  app.use('/api/board', boardRouter);
  app.use('/api/cards', cardsRouter);

  // ── Health check ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Error handler ───────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`🚀 Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
