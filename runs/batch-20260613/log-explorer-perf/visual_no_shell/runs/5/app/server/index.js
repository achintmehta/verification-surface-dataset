import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { createLogsRouter } from './routes/logs.js';
import { createStatsRouter } from './routes/stats.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('Initializing database...');
  const db = await initDb();
  console.log('Database ready.');

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api/logs', createLogsRouter(db));
  app.use('/api/stats', createStatsRouter(db));

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
