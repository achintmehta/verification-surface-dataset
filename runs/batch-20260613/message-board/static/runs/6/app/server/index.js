import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR ?? path.join(projectRoot, 'data', 'pglite');

const app = express();
const db = new PGlite(DATA_DIR);
const clients = new Set();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

function normalizeMessage(row) {
  return {
    id: Number(row.id),
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastMessage(message) {
  for (const client of clients) {
    sendSse(client, 'message', message);
  }
}

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (char_length(trim(text)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS messages_created_at_idx
      ON messages (created_at ASC, id ASC);
  `);
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

    if (text.length > 1000) {
      return res.status(400).json({ error: 'Message text must be 1000 characters or fewer.' });
    }

    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text]
    );
    const message = normalizeMessage(result.rows[0]);

    broadcastMessage(message);
    return res.status(201).json(message);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'ready', { connected: true });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    res.end();
  });
});

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(projectRoot, 'dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Message board API listening on http://localhost:${PORT}`);
      console.log(`PGLite data directory: ${DATA_DIR}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
