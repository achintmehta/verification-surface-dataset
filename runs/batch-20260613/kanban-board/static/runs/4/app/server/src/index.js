/**
 * Kanban Board – Express server entry point
 *
 * Starts the HTTP server after the database is initialised.
 * Routes:
 *   GET  /api/board           – full board snapshot
 *   POST /api/cards           – create a card
 *   PATCH /api/cards/:id/move – move / reorder a card
 *   GET  /api/stream          – SSE event stream
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // ── 1. Initialise database ──────────────────────────────────────────────
  await initDb();

  // ── 2. Build Express app ────────────────────────────────────────────────
  const app = express();

  app.use(cors({
    origin: true,          // reflect the request origin (dev-friendly)
    credentials: true,
  }));

  app.use(express.json());

  // ── 3. Mount routes ─────────────────────────────────────────────────────
  app.use('/api/board',  boardRouter);
  app.use('/api/cards',  cardsRouter);
  app.use('/api/stream', streamRouter);

  // Health-check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── 4. Start listening ──────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
