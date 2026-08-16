import express from 'express';
import cors from 'cors';
import { initDatabase } from './db.js';
import routes from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();

  // Initialize database (creates table, seeds if needed, creates indexes)
  await initDatabase();

  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
  app.use('/api', routes);

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.listen(PORT, () => {
    const bootTime = Date.now() - bootStart;
    console.log(`Server running on http://localhost:${PORT} (boot time: ${bootTime}ms)`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
