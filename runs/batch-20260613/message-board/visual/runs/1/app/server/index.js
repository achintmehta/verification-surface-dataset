import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // ── Database ────────────────────────────────────────────────────────────────
  await initDb();

  // ── Express app ─────────────────────────────────────────────────────────────
  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/api/messages', messagesRouter);
  app.use('/api/stream', streamRouter);

  // Health-check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Start ───────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal error during startup:', err);
  process.exit(1);
});
