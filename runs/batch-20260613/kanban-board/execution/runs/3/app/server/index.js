import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import router from './routes.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  await initDb();

  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  app.use('/api', router);

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal error', err);
  process.exit(1);
});
