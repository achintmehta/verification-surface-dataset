import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Database Initialization
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, '..', 'pgdata');
const db = new PGlite(DB_PATH);

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('[db] messages table ready');
}

// ---------------------------------------------------------------------------
// SSE – Active client connections
// ---------------------------------------------------------------------------
/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Broadcast a JSON payload to every connected SSE client.
 * @param {string} event  – SSE event name
 * @param {object} data   – JSON-serialisable payload
 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/messages – Return all historical messages (oldest first)
app.get('/api/messages', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/messages]', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/messages – Insert a new message, then broadcast it via SSE
app.post('/api/messages', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text.trim()]
    );
    const message = result.rows[0];

    // Broadcast the new message to all SSE clients
    broadcast('new-message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to create message' });
  }
});

// GET /api/stream – SSE endpoint for real-time updates
app.get('/api/stream', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send an initial comment to flush headers / confirm connection
  res.write(':connected\n\n');

  // Register this client
  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);

  // Clean up when the client disconnects
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
});

// ---------------------------------------------------------------------------
// Serve static frontend
// ---------------------------------------------------------------------------
// In production serve from client/dist; in development serve directly from client/
const distPath = path.join(__dirname, '..', 'client', 'dist');
const clientPath = path.join(__dirname, '..', 'client');
const fs = await import('fs');
const servePath = fs.existsSync(distPath) ? distPath : clientPath;
app.use(express.static(servePath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(servePath, 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
