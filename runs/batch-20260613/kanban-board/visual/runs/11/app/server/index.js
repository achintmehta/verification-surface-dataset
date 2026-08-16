import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { getBoard, createCard, moveCard } from './board.js';
import { addClient, broadcast } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Board state ---------------------------------------------------------
  app.get('/api/board', async (_req, res) => {
    try {
      const board = await getBoard();
      res.json({ columns: board });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load board' });
    }
  });

  // --- Create card ---------------------------------------------------------
  app.post('/api/cards', async (req, res) => {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text required' });
    }
    try {
      const card = await createCard(columnId, text.trim());
      broadcast('card:create', { card });
      res.status(201).json({ card });
    } catch (err) {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || 'Failed to create card' });
    }
  });

  // --- Move / reorder card -------------------------------------------------
  app.patch('/api/cards/:id/move', async (req, res) => {
    const { id } = req.params;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId required' });
    }
    try {
      const { card, renormalized } = await moveCard(id, columnId, beforeId, afterId);
      // Broadcast only committed state.
      broadcast('card:move', { card, renormalized });
      res.json({ card, renormalized });
    } catch (err) {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || 'Failed to move card' });
    }
  });

  // --- SSE stream ----------------------------------------------------------
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: connected\ndata: {"ok":true}\n\n`);

    const remove = addClient(res);

    // Heartbeat keeps proxies from closing idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      remove();
    });
  });

  // --- Static frontend (built) --------------------------------------------
  // When the frontend has been built (`npm run build`), serve it so the whole
  // app runs from a single origin. In dev, use the Vite dev server instead.
  const distDir = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
