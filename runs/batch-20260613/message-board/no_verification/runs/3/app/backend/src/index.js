/**
 * index.js
 * Entry point for the Message Board backend.
 *
 * Responsibilities:
 *  - Boot the embedded PGLite database (creates the messages table if needed)
 *  - Configure Express with CORS and JSON body parsing
 *  - Mount the /api/messages and /api/stream routers
 *  - Start listening on PORT (default 3001)
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialise the database before accepting any requests so that the table
  // is guaranteed to exist when the first query arrives.
  await getDb();

  const app = express();

  /* ------------------------------------------------------------------ */
  /* Middleware                                                           */
  /* ------------------------------------------------------------------ */

  // Allow the Vite dev server (typically :5173) to call the API during
  // development.  In production the frontend is served from the same origin
  // so CORS is not strictly required, but it does no harm.
  app.use(
    cors({
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        // Allow any localhost port for flexibility during development.
        /^http:\/\/localhost:\d+$/,
      ],
      methods: ['GET', 'POST', 'OPTIONS'],
    })
  );

  // Parse incoming JSON request bodies.
  app.use(express.json());

  /* ------------------------------------------------------------------ */
  /* Routes                                                              */
  /* ------------------------------------------------------------------ */

  app.use('/api/messages', messagesRouter);
  app.use('/api/stream', streamRouter);

  // Simple health-check endpoint.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  /* ------------------------------------------------------------------ */
  /* Start server                                                        */
  /* ------------------------------------------------------------------ */

  app.listen(PORT, () => {
    console.log(`[server] Message Board backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
