import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { initSchema } from './schema.js';
import { seedIfNeeded } from './seed.js';
import logsRouter from './routes/logs.js';
import statsRouter from './routes/stats.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('[boot] Starting log-explorer server...');
  const t0 = Date.now();

  // Initialize database
  const db = await getDb();
  console.log('[boot] PGLite ready.');

  // Create schema
  await initSchema(db);

  // Seed if needed
  await seedIfNeeded(db);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[boot] Ready in ${elapsed}s.`);

  // Express app
  const app = express();

  app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'],
    methods: ['GET'],
  }));

  app.use(express.json());

  // Routes
  app.use('/api/logs', logsRouter);
  app.use('/api/stats', statsRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // 404 for unknown API routes
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
