import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 1000;

const app = express();
const db = new PGlite(path.join(projectRoot, '.pglite'));
const sseClients = new Set();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function normalizeMessage(row) {
  return {
    id: row.id,
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function sendSse(res, payload, eventName = 'message') {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastMessage(message) {
  for (const client of sseClients) {
    sendSse(client, message);
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
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = normalizeMessage(result.rows[0]);

    broadcastMessage(message);
    res.status(201).json(message);
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
  sendSse(res, { connected: true }, 'ready');

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    res.end();
  });
});

const distPath = path.join(projectRoot, 'dist');
app.use(express.static(distPath));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await initializeDatabase();

app.listen(PORT, () => {
  console.log(`Message board API listening on http://localhost:${PORT}`);
});
