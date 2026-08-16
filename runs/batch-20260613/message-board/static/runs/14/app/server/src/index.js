import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import { router } from './routes.js';

async function main() {
  // Initialise the embedded PGLite database before accepting requests.
  await initDb();

  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  // All API routes are namespaced under /api.
  app.use('/api', router);

  // Centralised error handler so route handlers can simply call next(err).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Request error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
    console.log(`PGLite data directory: ${config.dataDir}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
