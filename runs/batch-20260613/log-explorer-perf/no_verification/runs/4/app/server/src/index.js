import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { createLogsRouter } from './routes/logs.js';
import { createStatsRouter } from './routes/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  console.log('[server] Starting log explorer server...');
  const startTime = Date.now();

  const db = await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api/logs', createLogsRouter(db));
  app.use('/api/stats', createStatsRouter(db));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Serve built frontend in production
  const publicDir = path.resolve(__dirname, '../public');
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(PORT, () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[server] Listening on http://localhost:${PORT} (boot took ${elapsed}s)`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});
