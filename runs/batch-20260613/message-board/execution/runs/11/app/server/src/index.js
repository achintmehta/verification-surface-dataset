import express from 'express';
import cors from 'cors';

import { initDb, getMessages, insertMessage } from './db.js';
import { addClient, broadcast } from './sse.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // 2.4 Historical messages: fetch the initial state.
  app.get('/api/messages', async (_req, res) => {
    try {
      const messages = await getMessages(db);
      res.json(messages);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // 3.1 SSE endpoint: keep an open stream for live updates.
  app.get('/api/stream', (req, res) => {
    addClient(req, res);
  });

  // 3.2 / 3.3 Post a new message, persist it, then broadcast to all clients.
  app.post('/api/messages', async (req, res) => {
    const { text } = req.body ?? {};

    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const trimmed = text.trim().slice(0, 2000);

    try {
      const message = await insertMessage(db, trimmed);
      broadcast('message', message);
      res.status(201).json(message);
    } catch (err) {
      console.error('Failed to insert message:', err);
      res.status(500).json({ error: 'Failed to save message' });
    }
  });

  app.listen(PORT, () => {
    console.log(`Realtime board server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
