import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, getMessages, insertMessage } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- SSE connection registry -------------------------------------------

// Set of active SSE client response objects.
const clients = new Set();

/**
 * Broadcast an event payload to all connected SSE clients.
 */
function broadcast(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

// --- Routes -------------------------------------------------------------

// Fetch historical messages for the initial state.
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Post a new message; insert into PGLite and broadcast to all clients.
app.post('/api/messages', async (req, res) => {
  const { text } = req.body || {};

  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  try {
    const message = await insertMessage(text.trim());
    broadcast(message);
    res.status(201).json(message);
  } catch (err) {
    console.error('Failed to insert message:', err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

// SSE endpoint: maintain a long-lived connection with each client.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  // Send an initial comment so the connection is recognised as open.
  res.write(': connected\n\n');

  clients.add(res);

  // Keep-alive ping to prevent intermediaries from closing the connection.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

// Serve the built frontend (production) if it exists.
app.use(express.static(path.join(__dirname, '..', 'dist')));

// --- Startup ------------------------------------------------------------

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
