/**
 * Entry point for the Kanban board backend.
 *
 * Starts an Express server with:
 *   - CORS + JSON body parsing
 *   - PGLite embedded database (file-system persistence)
 *   - REST API for board state and card mutations
 *   - SSE endpoint for real-time push to all connected clients
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { sseHandler } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialize database before accepting requests
  await initDb();

  const app = express();

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(cors({
    origin: true,          // reflect request origin (dev-friendly)
    credentials: true,
  }));
  app.use(express.json());

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get('/api/stream', sseHandler);
  app.use('/api/board', boardRouter);
  app.use('/api/cards', cardsRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Start ─────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Kanban backend listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
