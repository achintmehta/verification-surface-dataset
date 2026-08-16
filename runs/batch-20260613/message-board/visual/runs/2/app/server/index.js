import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import apiRouter from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3001;

async function main() {
  /* ── Database ─────────────────────────────────────────────────── */
  await initDb();

  /* ── Express app ──────────────────────────────────────────────── */
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // Simple health-check (must be before static middleware)
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Mount all API routes under /api
  app.use('/api', apiRouter);

  // Serve the frontend static files
  const frontendDir = path.join(__dirname, '..', 'frontend');
  app.use(express.static(frontendDir));

  // SPA fallback – serve index.html for any non-API route
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] frontend served from ${frontendDir}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
