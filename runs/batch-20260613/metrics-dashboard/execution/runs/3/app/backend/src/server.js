import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import apiRoutes from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialize database first
  await initDb();

  const app = express();

  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'PUT', 'POST'],
    allowedHeaders: ['Content-Type'],
  }));

  app.use(express.json());

  // Mount API routes
  app.use('/api', apiRoutes);

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.listen(PORT, () => {
    console.log(`[server] Metrics API running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
