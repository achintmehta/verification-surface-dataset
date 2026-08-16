/**
 * server/index.js
 * Entry point for the Express backend.
 *
 * Responsibilities:
 *   1. Initialise the embedded PGLite database (creates tables if needed)
 *   2. Mount middleware (CORS, JSON body parser)
 *   3. Mount API routes
 *   4. Start listening on PORT (default 3001)
 */

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Allow the Vite dev server (port 5173) and any other origin to reach the API.
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
  })
);

// Parse JSON request bodies.
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/messages', messagesRouter);
app.use('/api/stream', streamRouter);

// Simple health-check endpoint.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function start() {
  try {
    // Initialise the database before accepting any requests.
    await initDb();

    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] failed to start:', err);
    process.exit(1);
  }
}

start();
