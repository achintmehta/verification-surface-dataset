import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'pglite');
const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 500;

fs.mkdirSync(DATABASE_PATH, { recursive: true });

const app = express();
const db = new PGlite(DATABASE_PATH);
const clients = new Map();
let nextClientId = 1;

app.use(cors());
app.use(express.json({ limit: '32kb' }));

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (length(trim(text)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_created_at_id
    ON messages (created_at, id);
  `);
}

function normalizeMessage(row) {
  return {
    id: row.id,
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastMessage(message) {
  for (const res of clients.values()) {
    sendSse(res, 'message', message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/messages', async (_req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, text, created_at
       FROM (
         SELECT id, text, created_at
         FROM messages
         ORDER BY created_at DESC, id DESC
         LIMIT $1
       ) recent_messages
       ORDER BY created_at ASC, id ASC`,
      [HISTORY_LIMIT],
    );

    res.json(result.rows.map(normalizeMessage));
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
      [text],
    );

    const message = normalizeMessage(result.rows[0]);
    broadcastMessage(message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', (req, res) => {
  const clientId = nextClientId++;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  clients.set(clientId, res);

  // Send an initial event so the browser knows the stream is open.
  sendSse(res, 'ready', { clientId });

  req.on('close', () => {
    clients.delete(clientId);
    res.end();
  });
});

const heartbeat = setInterval(() => {
  for (const res of clients.values()) {
    res.write(': heartbeat\n\n');
  }
}, 25_000);

app.use(express.static(path.join(projectRoot, 'client', 'dist')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  const indexPath = path.join(projectRoot, 'client', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.status(404).send('Frontend has not been built yet. Run `npm run build` or use `npm run dev`.');
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);
  clearInterval(heartbeat);

  for (const res of clients.values()) {
    res.end();
  }
  clients.clear();

  if (typeof db.close === 'function') {
    await db.close();
  }

  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Message board server listening on http://localhost:${PORT}`);
      console.log(`PGLite database directory: ${DATABASE_PATH}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
