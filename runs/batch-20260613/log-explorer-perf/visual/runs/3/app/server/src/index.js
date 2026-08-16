import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import apiRouter from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('[server] Starting log-explorer backend...');

  // Initialize database (creates schema + seeds if needed)
  await initDb();

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Mount API routes
  app.use('/api', apiRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
