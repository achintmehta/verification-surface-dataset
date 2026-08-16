import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { logsRouter } from './routes/logs.js';
import { statsRouter } from './routes/stats.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('[server] Initializing database...');
  const db = await initDb();
  console.log('[server] Database ready.');

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api/logs', logsRouter(db));
  app.use('/api/stats', statsRouter(db));

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});
