/**
 * Log Explorer Backend Server
 * Node.js + Express + PGLite
 */
import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import apiRouter from './routes.js';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const PORT = process.env.PORT || 3001;

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173'],
  methods: ['GET'],
}));
app.use(express.json());

// Health check (before DB init so it can respond during startup)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Mount API routes
app.use('/api', apiRouter);

// Initialize database then start server
const bootStart = Date.now();
console.log('[server] Initializing database...');

initDb()
  .then(() => {
    app.listen(PORT, () => {
      const bootMs = Date.now() - bootStart;
      console.log(`[server] Listening on http://localhost:${PORT} (boot: ${bootMs}ms)`);
    });
  })
  .catch((err) => {
    console.error('[server] Fatal: failed to initialize database', err);
    process.exit(1);
  });
