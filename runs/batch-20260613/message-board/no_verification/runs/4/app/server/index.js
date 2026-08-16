import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3000;

async function main() {
  // ── 1. Initialise the embedded PGLite database ──────────────────────────
  await initDb();

  // ── 2. Create the Express application ───────────────────────────────────
  const app = express();

  // Allow the Vite dev server (port 5173) and any other origin to reach the
  // API during development.  In production the frontend is served as static
  // files from the same origin so CORS is not strictly required, but it
  // doesn't hurt to keep it permissive for a local-first app.
  app.use(cors());

  // Parse incoming JSON request bodies (used by POST /api/messages).
  app.use(express.json());

  // ── 3. Mount API routes ──────────────────────────────────────────────────
  app.use('/api/messages', messagesRouter);
  app.use('/api/stream', streamRouter);

  // ── 4. Health-check endpoint ─────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── 5. Start listening ───────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal error during startup:', err);
  process.exit(1);
});
