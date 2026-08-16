import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { getDb } from './db.js';
import { seedDatabase } from './seed.js';
import summaryRouter from './routes/summary.js';
import timeseriesRouter from './routes/timeseries.js';
import categoriesRouter from './routes/categories.js';
import recentRouter from './routes/recent.js';
import settingsRouter from './routes/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  // Initialise DB and seed
  const db = await getDb();
  await seedDatabase(db);

  const app = express();

  // In development the Vite dev server runs on :5173; allow that origin.
  // In production the client is served from the same origin so CORS is moot.
  app.use(cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      `http://localhost:${PORT}`,
    ],
  }));
  app.use(express.json());

  // API Routes
  app.use('/api/summary',    summaryRouter);
  app.use('/api/timeseries', timeseriesRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/recent',     recentRouter);
  app.use('/api/settings',   settingsRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Serve the built client in production
  const publicDir = join(__dirname, '..', 'public');
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    // SPA fallback
    app.get('*', (_req, res) => {
      res.sendFile(join(publicDir, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
