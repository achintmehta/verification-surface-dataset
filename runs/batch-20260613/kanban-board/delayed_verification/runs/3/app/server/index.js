/**
 * Entry point for the Kanban board backend.
 *
 * Starts an Express server with:
 *   - CORS (allows the Vite dev server on :5173)
 *   - JSON body parsing
 *   - PGLite database initialisation
 *   - Route mounting
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialise the database before accepting requests
  await initDb();
  console.log('[db] PGLite ready');

  const app = express();

  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    })
  );

  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────
  app.use('/api/board', boardRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
