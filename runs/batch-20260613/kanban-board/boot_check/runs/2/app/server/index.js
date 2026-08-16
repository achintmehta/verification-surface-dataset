import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialise the database first
  await initDb();

  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // ── SSE endpoint ────────────────────────────────────────────────────
  app.get('/api/stream', (req, res) => {
    addClient(req, res);
  });

  // ── REST API ────────────────────────────────────────────────────────
  app.use('/api/board', boardRouter);
  app.use('/api/cards', cardsRouter);

  // ── Health check ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Start ───────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Kanban backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
