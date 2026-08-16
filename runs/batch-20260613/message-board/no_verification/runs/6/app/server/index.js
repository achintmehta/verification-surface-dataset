import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(projectRoot, '.pglite');
const CLIENT_DIST_PATH = path.join(projectRoot, 'client', 'dist');

const app = express();
const db = new PGlite(DATABASE_PATH);
const sseClients = new Set();

app.use(cors());
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

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const client = { res };
  sseClients.add(client);

  res.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);

  req.on('close', () => {
    sseClients.delete(client);
  });
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
      [text]
    );

    const message = serializeMessage(result.rows[0]);
    broadcastMessage(message);
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(CLIENT_DIST_PATH));

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(path.join(CLIENT_DIST_PATH, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

const heartbeat = setInterval(() => {
  for (const client of sseClients) {
    client.res.write(': heartbeat\n\n');
  }
}, 30_000);

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  console.log(`Message board server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_PATH}`);
});

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
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function broadcastMessage(message) {
  const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;

  for (const client of sseClients) {
    client.res.write(payload);
  }
}

function shutdown() {
  clearInterval(heartbeat);

  for (const client of sseClients) {
    client.res.end();
  }

  process.exit(0);
}
