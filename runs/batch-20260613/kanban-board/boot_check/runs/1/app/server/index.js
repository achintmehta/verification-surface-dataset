import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialise the database before accepting requests
  await initDb();

  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── API routes ──────────────────────────────────────────────
  app.get('/api/stream', (req, res) => addClient(req, res));
  app.use('/api/board', boardRouter);
  app.use('/api/cards', cardsRouter);

  // ── Health check ────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});
