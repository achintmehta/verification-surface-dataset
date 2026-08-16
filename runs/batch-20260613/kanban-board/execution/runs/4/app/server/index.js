import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import routes from './routes.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  await initDb();

  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api', routes);

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
