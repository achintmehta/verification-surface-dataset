import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { logsRouter } from './routes/logs.js';
import { statsRouter } from './routes/stats.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('Initializing database...');
  const db = await initDb();
  console.log('Database ready.');

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Attach db to request
  app.use((req, _res, next) => {
    req.db = db;
    next();
  });

  app.use('/api/logs', logsRouter);
  app.use('/api/stats', statsRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
