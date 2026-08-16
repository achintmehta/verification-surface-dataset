import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import apiRouter from './routes.js';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  console.log('[server] Starting log-explorer backend...');

  // Initialize database (creates schema + seeds if needed)
  await initDb();

  const app = express();

  // Middleware
  app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'],
    methods: ['GET'],
  }));
  app.use(express.json());

  // API routes
  app.use('/api', apiRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.listen(PORT, () => {
    const bootMs = Date.now() - bootStart;
    console.log(`[server] Listening on http://localhost:${PORT} (boot: ${bootMs}ms)`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
