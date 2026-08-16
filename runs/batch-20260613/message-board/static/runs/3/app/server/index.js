/**
 * server/index.js
 * Entry point for the Express backend.
 *
 * Start order:
 *   1. Initialise PGLite (creates the DB file and schema if needed).
 *   2. Mount Express middleware and routes.
 *   3. Begin listening for HTTP connections.
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

// Allow the Vite dev server (port 5173) to call the API during development.
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
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
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function start() {
  try {
    // Initialise the embedded database before accepting any requests.
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
