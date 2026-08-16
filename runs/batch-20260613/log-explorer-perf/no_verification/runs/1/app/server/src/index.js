import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { initSchema } from './schema.js';
import { seedDatabase } from './seed.js';
import logsRouter from './routes/logs.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const t0 = Date.now();
  console.log('[server] Starting log-explorer backend...');

  // Initialize database
  const db = await getDb();
  console.log('[server] PGLite database ready.');

  // Initialize schema (idempotent)
  await initSchema(db);

  // Seed if needed
  await seedDatabase(db);

  console.log(`[server] Boot complete in ${Date.now() - t0}ms`);

  // Set up Express
  const app = express();

  app.use(cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }));

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // API routes
  app.use('/api', logsRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});
