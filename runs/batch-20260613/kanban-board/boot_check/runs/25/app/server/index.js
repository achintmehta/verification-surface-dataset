import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { initDb } from './db.js';
import { createBoardRoutes } from './routes/board.js';
import { createCardRoutes } from './routes/cards.js';
import { createSSEManager } from './sse.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'pgdata');

async function main() {
  // Initialize PGLite with local filesystem persistence
  const db = new PGlite(DB_PATH);
  await initDb(db);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static files from client build in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // SSE manager
  const sse = createSSEManager();

  // Routes
  app.use('/api', createBoardRoutes(db));
  app.use('/api', createCardRoutes(db, sse));
  app.get('/api/stream', (req, res) => {
    sse.addClient(req, res);
  });

  // Fallback to index.html for SPA
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
