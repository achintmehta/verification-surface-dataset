import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, 'data', 'pglite');

const app = express();
const clients = new Set();

app.use(cors());
app.use(express.json({ limit: '64kb' }));

await mkdir(DB_DIR, { recursive: true });
const db = new PGlite(DB_DIR);

await db.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    text TEXT NOT NULL CHECK (char_length(trim(text)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

function normalizeMessage(row) {
  return {
    id: Number(row.id),
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function sendSse(res, event, data) {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(message) {
  for (const res of clients) {
    sendSse(res, 'message', message);
  }
}

app.get('/api/health', (_req, res) => {
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

    if (text.length > 1000) {
      return res.status(400).json({ error: 'Message text must be 1000 characters or fewer.' });
    }

    const result = await db.query(
      `INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;`,
      [text]
    );
    const message = normalizeMessage(result.rows[0]);

    broadcast(message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(': connected\n\n');
  clients.add(res);

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) {
      res.status(404).send('Frontend has not been built yet. Run `npm run build` or use `npm run dev`.');
    }
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(PORT, () => {
  console.log(`Message board server listening on http://localhost:${PORT}`);
});

function shutdown() {
  server.close(async () => {
    try {
      await db.close();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
