/**
 * Entry point for the Kanban board backend.
 *
 * Starts an Express server with:
 *   - CORS (allows the Vite dev server on :5173)
 *   - JSON body parsing
 *   - PGLite database initialization
 *   - REST routes for board state and card mutations
 *   - SSE endpoint for real-time push
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/board',  boardRouter);
app.use('/api/cards',  cardsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
    console.log('✅ PGLite database ready');

    app.listen(PORT, () => {
      console.log(`🚀 Kanban server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
