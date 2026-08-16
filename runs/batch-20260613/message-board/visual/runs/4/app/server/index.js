import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Database Setup ───────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, '..', 'data', 'messages.db');
const db = new PGlite(`file://${DB_PATH}`);

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('[db] messages table ready');
}

// ─── SSE Client Registry ──────────────────────────────────────────────────────

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ── GET /api/messages ─ fetch historical messages ────────────────────────────
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

// ── GET /api/stream ─ SSE endpoint ───────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a heartbeat comment immediately so the browser knows the connection is live
  res.write(': connected\n\n');

  sseClients.add(res);
  console.log(`[sse] client connected  (total: ${sseClients.size})`);

  // Heartbeat every 25 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[sse] client disconnected (total: ${sseClients.size})`);
  });
});

// ── POST /api/messages ─ insert a new message ────────────────────────────────
app.post('/api/messages', async (req, res) => {
  const text = (req.body?.text ?? '').trim();

  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'text must be 2000 characters or fewer' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = result.rows[0];

    // Push to all connected SSE clients
    broadcast(message);

    res.status(201).json(message);
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] failed to initialise database', err);
    process.exit(1);
  });
