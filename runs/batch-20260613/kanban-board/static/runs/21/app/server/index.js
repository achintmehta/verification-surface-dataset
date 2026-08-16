import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import routes from './routes.js';

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize PGLite (creates tables + seeds data on first run)
  await initDb();
  console.log('Database initialized');

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Mount API routes
  app.use('/api', routes);

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
