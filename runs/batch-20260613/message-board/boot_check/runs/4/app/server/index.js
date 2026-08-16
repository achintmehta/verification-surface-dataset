import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3000;

async function main() {
  // ── Database ────────────────────────────────────────────────────────────────
  await initDb();

  // ── Express app ─────────────────────────────────────────────────────────────
  const app = express();

  // Allow the Vite dev server (port 5173) to call the API during development.
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));

  // Parse JSON request bodies.
  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/api/messages', messagesRouter);
  app.use('/api/stream', streamRouter);

  // Simple health-check endpoint.
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
