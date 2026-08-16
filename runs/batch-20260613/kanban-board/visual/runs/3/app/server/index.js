import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DIST_DIR = path.join(__dirname, '..', 'dist');

async function main() {
  // ── Database ──────────────────────────────────────────────────────────────
  await initDb();

  // ── Express app ───────────────────────────────────────────────────────────
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // ── API routes ────────────────────────────────────────────────────────────
  app.get('/api/stream', (req, res) => addClient(req, res));
  app.use('/api/board',  boardRouter);
  app.use('/api/cards',  cardsRouter);

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ── Serve built frontend (if dist exists) ─────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
    console.log(`[server] serving static files from ${DIST_DIR}`);
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
