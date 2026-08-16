import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import logsRouter from './routes/logs.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('[server] Initializing database...');
  const t0 = Date.now();

  try {
    await initDb();
  } catch (err) {
    console.error('[server] Failed to initialize database:', err);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[server] Database ready in ${elapsed}s`);

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // API routes
  app.use('/api', logsRouter);

  // 404 handler
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main();
