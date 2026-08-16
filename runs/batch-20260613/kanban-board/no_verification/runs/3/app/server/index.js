/**
 * Entry point for the Kanban board backend.
 *
 * Starts an Express server after the PGLite database is ready.
 * Routes:
 *   GET  /api/board          – full board state
 *   POST /api/cards          – create a card
 *   PATCH /api/cards/:id/move – move / reorder a card
 *   GET  /api/stream         – SSE event stream
 */

import express from 'express';
import cors from 'cors';
import { ready } from './db.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors({ origin: '*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/board', boardRouter);
app.use('/api/cards', cardsRouter);
app.use('/api/stream', streamRouter);

// Health check.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] Kanban backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to initialise database:', err);
    process.exit(1);
  });
