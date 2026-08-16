import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.PGLITE_DATA_DIR || './.pglite';

const app = express();
const db = new PGlite(DB_PATH);
const clients = new Set();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (char_length(trim(text)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function normalizeMessage(row) {
  return {
    id: row.id,
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: clients.size });
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
      return res.status(413).json({ error: 'Message text must be 1000 characters or less.' });
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

  clients.add(res);
  sendSse(res, 'connected', { ok: true, clients: clients.size });

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
    res.end();
  });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await initDatabase();
app.listen(PORT, () => {
  console.log(`Message board API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DB_PATH}`);
});
