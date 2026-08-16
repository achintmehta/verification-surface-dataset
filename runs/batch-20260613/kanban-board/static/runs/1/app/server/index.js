/**
 * Kanban Board – Express server entry point.
 *
 * Starts the HTTP server only after the database has been initialised so
 * that no request can arrive before the schema / seed data is ready.
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { sseHandler } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

/* ------------------------------------------------------------------ */
/*  Middleware                                                           */
/* ------------------------------------------------------------------ */

app.use(cors({
  origin: true,          // reflect the request origin (dev convenience)
  credentials: true,
}));

app.use(express.json());

/* ------------------------------------------------------------------ */
/*  Routes                                                              */
/* ------------------------------------------------------------------ */

// Real-time SSE stream – must be registered before any body-parsing
// middleware would buffer the response.
app.get('/api/stream', sseHandler);

app.use('/api/board', boardRouter);
app.use('/api/cards', cardsRouter);

// Simple health-check.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ */
/*  Boot                                                                */
/* ------------------------------------------------------------------ */

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
