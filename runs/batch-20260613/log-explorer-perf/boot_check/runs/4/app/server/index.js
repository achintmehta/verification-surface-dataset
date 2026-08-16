import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { initSchema } from './schema.js';
import { seedIfNeeded } from './seed.js';
import logsRouter from './routes/logs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('[server] Starting...');

  // Initialize database
  const db = await getDb();
  console.log('[server] PGLite database connected.');

  // Initialize schema (idempotent)
  await initSchema(db);

  // Seed data if needed
  await seedIfNeeded(db);

  // Set up Express
  const app = express();

  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET'],
  }));

  app.use(express.json());

  // API routes
  app.use('/api', logsRouter);

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve built frontend in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    const indexPath = path.join(clientDist, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) res.status(404).send('Not found');
    });
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
