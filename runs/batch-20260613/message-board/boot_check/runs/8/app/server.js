import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, 'pgdata');

const app = express();
const db = new PGlite(DATA_DIR);
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

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastNewMessage(message) {
  for (const client of sseClients) {
    sendSse(client, 'message', message);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/messages', async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT id, text, created_at
      FROM messages
      ORDER BY created_at ASC, id ASC;
    `);
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

    if (text.length > 2000) {
      return res.status(400).json({ error: 'Message text must be 2000 characters or fewer.' });
    }

    const result = await db.query(
      `
        INSERT INTO messages (text)
        VALUES ($1)
        RETURNING id, text, created_at;
      `,
      [text]
    );
    const message = normalizeMessage(result.rows[0]);

    broadcastNewMessage(message);
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

  sendSse(res, 'ready', { connected: true });
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    res.end();
  });
});

const distDir = path.join(__dirname, 'dist');
const clientDir = path.join(__dirname, 'client');
const staticDir = process.env.NODE_ENV === 'production' ? distDir : clientDir;

app.use(express.static(staticDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Message board server listening on http://localhost:${PORT}`);
      console.log(`PGLite data directory: ${DATA_DIR}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
