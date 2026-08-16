import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import logsRouter from './routes/logs.js';

const PORT = process.env.PORT || 3001;

// DB readiness promise - resolves when DB is ready
let dbReadyResolve;
const dbReady = new Promise((resolve) => { dbReadyResolve = resolve; });
let dbError = null;

async function main() {
  const app = express();

  // Middleware
  app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'],
    methods: ['GET'],
  }));
  app.use(express.json());

  // Health check - responds immediately, even before DB is ready
  app.get('/health', (req, res) => {
    if (dbError) {
      return res.status(503).json({ status: 'error', error: dbError.message });
    }
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // DB readiness middleware for API routes
  app.use('/api', async (req, res, next) => {
    try {
      await dbReady;
      next();
    } catch (err) {
      res.status(503).json({ error: 'Database not ready' });
    }
  });

  // API routes
  app.use('/api', logsRouter);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start listening immediately (health check available right away)
  app.listen(PORT, () => {
    console.log(`Log Explorer API server listening on http://localhost:${PORT}`);
  });

  // Initialize database in background
  console.log('Starting database initialization...');
  const bootStart = Date.now();

  try {
    await initDb();
    const bootElapsed = ((Date.now() - bootStart) / 1000).toFixed(1);
    console.log(`Database ready in ${bootElapsed}s`);
    dbReadyResolve();
  } catch (err) {
    dbError = err;
    console.error('Fatal error during database initialization:', err);
    dbReadyResolve(); // resolve anyway so API requests get 503 instead of hanging
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
