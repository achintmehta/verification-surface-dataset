/**
 * Entry point for the Kanban board backend.
 * Starts Express, initializes PGLite, and mounts all routes.
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialize database first
  await initDb();

  const app = express();

  // Middleware
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // Routes
  app.use('/api/board', boardRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[server] Kanban backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
