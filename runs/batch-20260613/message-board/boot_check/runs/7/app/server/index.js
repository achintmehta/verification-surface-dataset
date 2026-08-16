import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_PATH = process.env.PGLITE_DATA_DIR ?? path.join(rootDir, 'data', 'pglite');
const MAX_MESSAGE_LENGTH = 1000;

fs.mkdirSync(DATABASE_PATH, { recursive: true });

const app = express();
const db = new PGlite(DATABASE_PATH);
const sseClients = new Set();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

function normalizeMessage(row) {
  return {
    id: Number(row.id),
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (char_length(text) > 0 AND char_length(text) <= ${MAX_MESSAGE_LENGTH}),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at, id);
  `);
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastMessage(message) {
  for (const client of sseClients) {
    sendSse(client, 'message', message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/messages', async (_req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC LIMIT 500'
    );

    res.json({ messages: result.rows.map(normalizeMessage) });
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
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = normalizeMessage(result.rows[0]);

    broadcastMessage(message);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);
  res.write(': connected\n\n');
  sendSse(res, 'ready', { connected: true });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    res.end();
  });
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.use(express.static(rootDir));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(path.join(distDir, 'index.html'), (distError) => {
    if (!distError) return;
    res.sendFile(path.join(rootDir, 'index.html'), (sourceError) => {
      if (sourceError) next(sourceError);
    });
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await initializeDatabase();

app.listen(PORT, () => {
  console.log(`Message board server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_PATH}`);
});
