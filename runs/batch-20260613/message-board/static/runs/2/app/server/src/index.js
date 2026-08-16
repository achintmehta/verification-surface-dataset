import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3000;

async function main() {
  // Initialise the embedded database before accepting any requests.
  await initDb();

  const app = express();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  // Allow the Vite dev server (default: http://localhost:5173) to call the API
  // during development.  In production the frontend is served as static files
  // from the same origin so CORS is not strictly required, but it doesn't hurt.
  app.use(
    cors({
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ],
      methods: ['GET', 'POST'],
    })
  );

  app.use(express.json());

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  app.use('/api/messages', messagesRouter);
  app.use('/api/stream', streamRouter);

  // Simple health-check endpoint.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal error during startup:', err);
  process.exit(1);
});
