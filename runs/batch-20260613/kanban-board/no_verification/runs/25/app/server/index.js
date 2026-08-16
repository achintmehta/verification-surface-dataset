import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { initDb } from './db.js';
import { createBoardRoutes } from './routes/board.js';
import { createCardRoutes } from './routes/cards.js';
import { createSSEManager } from './sse.js';

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data/kanban-db';

async function main() {
  // Initialize PGLite with local file system persistence
  const db = new PGlite(DATA_DIR);
  await initDb(db);

  const app = express();
  app.use(cors());
  app.use(express.json());

  const sseManager = createSSEManager();

  // SSE endpoint
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    const clientId = sseManager.addClient(res);

    req.on('close', () => {
      sseManager.removeClient(clientId);
    });
  });

  // Board & card routes
  app.use('/api', createBoardRoutes(db));
  app.use('/api', createCardRoutes(db, sseManager));

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
