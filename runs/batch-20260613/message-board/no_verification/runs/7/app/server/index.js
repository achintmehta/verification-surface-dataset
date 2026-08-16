import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_PATH = process.env.PGLITE_DATA_DIR ?? path.join(rootDir, 'data', 'pglite');

const app = express();
const db = new PGlite(DATABASE_PATH);
const sseClients = new Set();

app.use(cors());
app.use(express.json({ limit: '64kb' }));

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (char_length(trim(text)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS messages_created_at_idx
      ON messages (created_at ASC, id ASC);
  `);
}

function serializeMessage(row) {
  return {
    id: String(row.id),
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastMessage(message) {
  for (const res of sseClients) {
    if (res.writableEnded || res.destroyed) {
      sseClients.delete(res);
      continue;
    }
    sendSse(res, message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const result = await db.query(
      `SELECT id, text, created_at
         FROM messages
        ORDER BY created_at ASC, id ASC
        LIMIT $1`,
      [Number.isFinite(limit) && limit > 0 ? limit : 100],
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

    if (text.length > 1000) {
      return res.status(400).json({ error: 'Message text must be 1000 characters or fewer.' });
    }

    const result = await db.query(
      `INSERT INTO messages (text)
       VALUES ($1)
       RETURNING id, text, created_at`,
      [text],
    );

    const message = serializeMessage(result.rows[0]);
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

  res.write(': connected\n\n');
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      sseClients.delete(res);
      return;
    }
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    res.end();
  });
});

app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error.' });
});

await initializeDatabase();

app.listen(PORT, () => {
  console.log(`Message board API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_PATH}`);
});
