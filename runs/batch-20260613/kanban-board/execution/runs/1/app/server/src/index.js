/**
 * Entry point for the Kanban board backend server.
 * Initializes PGLite, mounts routes, and starts listening.
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import apiRouter from './routes.js';

const PORT = process.env.PORT ?? 3001;
const HOST = process.env.HOST ?? 'localhost';

async function main() {
  // Initialize database first
  await initDb();

  const app = express();

  // Middleware
  app.use(cors({
    origin: true,          // Reflect the request origin (dev-friendly)
    credentials: true,
  }));
  app.use(express.json());

  // Mount API routes
  app.use('/api', apiRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.listen(PORT, HOST, () => {
    console.log(`[server] Kanban backend listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
