import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import router from './routes.js';

const PORT = process.env.PORT ?? 3000;

async function main() {
  // ------------------------------------------------------------------
  // 1. Initialise the embedded PGLite database (creates tables if needed)
  // ------------------------------------------------------------------
  await initDb();

  // ------------------------------------------------------------------
  // 2. Build the Express application
  // ------------------------------------------------------------------
  const app = express();

  // Allow the Vite dev server (port 5173) to call the API during development
  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      methods: ['GET', 'POST', 'OPTIONS'],
    })
  );

  // Parse JSON request bodies
  app.use(express.json());

  // Mount all API routes under /api
  app.use('/api', router);

  // ------------------------------------------------------------------
  // 3. Start listening
  // ------------------------------------------------------------------
  app.listen(PORT, () => {
    console.log(`[server] Message board backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
