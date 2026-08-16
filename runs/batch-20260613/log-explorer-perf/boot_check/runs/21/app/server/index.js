import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { registerRoutes } from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const startTime = Date.now();
  console.log('[boot] Starting log explorer server...');

  const app = express();
  app.use(cors());
  app.use(express.json());

  const db = await initDb();
  console.log(`[boot] Database ready in ${Date.now() - startTime}ms`);

  registerRoutes(app, db);

  app.listen(PORT, () => {
    console.log(`[boot] Server listening on port ${PORT} (total boot: ${Date.now() - startTime}ms)`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
