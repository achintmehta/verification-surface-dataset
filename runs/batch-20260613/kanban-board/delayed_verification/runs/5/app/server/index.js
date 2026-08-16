/**
 * server/index.js – Express application entry point.
 *
 * Starts the HTTP server, wires up middleware and routes, and ensures the
 * PGLite database is initialised before accepting requests.
 */

import express from 'express';
import cors    from 'cors';
import { getDb }      from './db.js';
import boardRouter    from './routes/board.js';
import cardsRouter    from './routes/cards.js';
import streamRouter   from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/board',  boardRouter);
app.use('/api/cards',  cardsRouter);
app.use('/api/stream', streamRouter);

// Simple health-check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: err.message ?? 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  try {
    // Initialise the database (creates schema + seeds columns if needed)
    // before we start accepting connections.
    await getDb();
    console.log('[db] PGLite ready');

    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[fatal] failed to start server:', err);
    process.exit(1);
  }
})();
