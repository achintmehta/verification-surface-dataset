/**
 * Kanban Board – Express server
 *
 * Endpoints:
 *   GET  /api/board           – full board state (columns + cards)
 *   POST /api/cards           – create a card
 *   PATCH /api/cards/:id/move – move / reorder a card
 *   GET  /api/stream          – SSE stream for real-time updates
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { addClient } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(
  cors({
    origin: true, // reflect the request origin – fine for a local dev tool
    credentials: true,
  }),
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/board', boardRouter);
app.use('/api/cards', cardsRouter);

// SSE stream endpoint
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function start() {
  try {
    // Initialise the database (creates schema + seeds columns if needed)
    // before accepting any requests.
    await getDb();
    console.log('[db] PGLite ready');

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
