import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import routes from './routes.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialize the database first
  await initDb();

  const app = express();

  app.use(cors({
    origin: true,
    credentials: true,
  }));
  app.use(express.json());

  // Mount API routes
  app.use('/api', routes);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.listen(PORT, () => {
    console.log(`[server] Kanban backend listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
