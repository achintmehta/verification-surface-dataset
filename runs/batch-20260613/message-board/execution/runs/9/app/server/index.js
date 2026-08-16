import cors from 'cors';
import express from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(projectRoot, 'data', 'pglite');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const MAX_MESSAGE_LENGTH = 1000;

mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const db = new PGlite(DATA_DIR);
const sseClients = new Map();
let nextClientId = 1;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? false : CLIENT_ORIGIN }));
app.use(express.json({ limit: '32kb' }));

await initializeDatabase();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/messages', async (_req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, text, created_at
       FROM messages
       ORDER BY created_at ASC, id ASC`
    );

    res.json(result.rows.map(serializeMessage));
  } catch (error) {
    next(error);
  }
});

app.post('/api/messages', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      return res.status(400).json({ error: 'Message text is required.' });
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message text must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });
    }

    const result = await db.query(
      `INSERT INTO messages (text)
       VALUES ($1)
       RETURNING id, text, created_at`,
      [text]
    );

    const message = serializeMessage(result.rows[0]);
    broadcastSseEvent('message', message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', (req, res) => {
  const clientId = nextClientId++;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  writeSseEvent(res, 'connected', { clientId });
  res.write(': stream opened\n\n');

  sseClients.set(clientId, res);

  req.on('close', () => {
    sseClients.delete(clientId);
  });
});

const heartbeat = setInterval(() => {
  for (const response of sseClients.values()) {
    response.write(': heartbeat\n\n');
  }
}, 25_000);
heartbeat.unref?.();

const distDir = path.join(projectRoot, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(distDir, 'index.html'));
    }
    next();
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(PORT, () => {
  console.log(`Message board API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(heartbeat);
    for (const response of sseClients.values()) {
      response.end();
    }
    sseClients.clear();
    server.close(async () => {
      await db.close?.();
      process.exit(0);
    });
  });
}

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function serializeMessage(row) {
  return {
    id: Number(row.id),
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

function broadcastSseEvent(eventName, payload) {
  for (const [clientId, response] of sseClients.entries()) {
    try {
      writeSseEvent(response, eventName, payload);
    } catch (error) {
      console.error(`Removing failed SSE client ${clientId}:`, error);
      sseClients.delete(clientId);
      response.end();
    }
  }
}

function writeSseEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
