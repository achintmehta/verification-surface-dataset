import express from 'express';
import cors from 'cors';
import { getDb, initSchema, seedIfEmpty } from './db.js';
import summaryRouter    from './routes/summary.js';
import timeseriesRouter from './routes/timeseries.js';
import categoriesRouter from './routes/categories.js';
import recentRouter     from './routes/recent.js';
import settingsRouter   from './routes/settings.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await getDb();
  await initSchema(db);
  await seedIfEmpty(db);

  const app = express();

  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  app.use(express.json());

  // Attach db to app locals so routes can access it
  app.locals.db = db;

  app.use('/api/summary',    summaryRouter);
  app.use('/api/timeseries', timeseriesRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/recent',     recentRouter);
  app.use('/api/settings',   settingsRouter);

  // Generic error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
