/**
 * Entry point for the Kanban board backend.
 *
 * Starts an Express server with:
 *   - CORS (allows the Vite dev server on :5173)
 *   - JSON body parsing
 *   - PGLite database initialisation
 *   - Board API routes
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import boardRouter from './routes/board.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

app.use(express.json());

// Mount all board API routes under /api.
app.use('/api', boardRouter);

// Health check.
app.get('/health', (_req, res) => res.json({ ok: true }));

// Initialise the database, then start listening.
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] Kanban backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to initialise database:', err);
    process.exit(1);
  });
