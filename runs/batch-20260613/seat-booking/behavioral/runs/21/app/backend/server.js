import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, initSchema } from './db.js';
import { createRouter } from './routes.js';
import { startExpirySweep } from './holdExpiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve frontend static files in production
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));

  const db = await getDb();
  await initSchema(db);

  const apiRouter = createRouter(db);
  app.use('/api', apiRouter);

  // Fallback to index.html for SPA
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  // Start the periodic expiry sweep
  startExpirySweep(db, 1000);

  app.listen(PORT, () => {
    console.log(`Seat booking server running on http://localhost:${PORT}`);
  });
}

main().catch(console.error);
