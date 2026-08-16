import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import apiRouter from './routes.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  /* ---------------------------------------------------------------- */
  /*  1. Boot the embedded database                                    */
  /* ---------------------------------------------------------------- */
  await initDb();

  /* ---------------------------------------------------------------- */
  /*  2. Configure Express                                             */
  /* ---------------------------------------------------------------- */
  const app = express();

  // Allow the Vite dev server (port 5173) to call the API during development
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));

  // Parse JSON request bodies
  app.use(express.json());

  /* ---------------------------------------------------------------- */
  /*  3. Mount API routes                                              */
  /* ---------------------------------------------------------------- */
  app.use('/api', apiRouter);

  /* ---------------------------------------------------------------- */
  /*  4. Health-check                                                  */
  /* ---------------------------------------------------------------- */
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  /* ---------------------------------------------------------------- */
  /*  5. Start listening                                               */
  /* ---------------------------------------------------------------- */
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
