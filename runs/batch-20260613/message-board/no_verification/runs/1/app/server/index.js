import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import messagesRouter from './routes/messages.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // ------------------------------------------------------------------
  // 1. Initialise the embedded PGLite database before accepting traffic.
  // ------------------------------------------------------------------
  await initDb();

  // ------------------------------------------------------------------
  // 2. Create and configure the Express application.
  // ------------------------------------------------------------------
  const app = express();

  // Allow the Vite dev server (port 5173) and any other origin to call the API.
  app.use(cors({
    origin: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  }));

  // Parse incoming JSON request bodies.
  app.use(express.json());

  // ------------------------------------------------------------------
  // 3. Mount API routes.
  // ------------------------------------------------------------------
  app.use('/api/messages', messagesRouter);
  app.use('/api/stream', streamRouter);

  // Simple health-check endpoint.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ------------------------------------------------------------------
  // 4. Start listening.
  // ------------------------------------------------------------------
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
