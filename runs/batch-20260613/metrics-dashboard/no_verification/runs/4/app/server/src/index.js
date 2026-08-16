import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { createApiRouter } from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const app = express();

  app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'PUT', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }));

  app.use(express.json());

  console.log('Initializing database...');
  const db = await initDb();
  console.log('Database ready.');

  app.use('/api', createApiRouter(db));

  app.listen(PORT, () => {
    console.log(`Metrics dashboard server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
