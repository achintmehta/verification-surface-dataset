import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { seedDatabase } from './seed.js';
import summaryRouter    from './routes/summary.js';
import timeseriesRouter from './routes/timeseries.js';
import categoriesRouter from './routes/categories.js';
import recentRouter     from './routes/recent.js';
import settingsRouter   from './routes/settings.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialise & seed DB before accepting requests
  const db = await getDb();
  await seedDatabase(db);

  const app = express();

  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  app.use(express.json());

  app.use('/api/summary',    summaryRouter);
  app.use('/api/timeseries', timeseriesRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/recent',     recentRouter);
  app.use('/api/settings',   settingsRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
