import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const DATABASE_DIR = process.env.PGLITE_DATA_DIR || path.join(projectRoot, '.pgdata');

const app = express();
const db = new PGlite(DATABASE_DIR);
const clients = new Set();

app.use(cors());
app.use(express.json({ limit: '16kb' }));

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (char_length(trim(text)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function normalizeMessage(row) {
  return {
    id: Number(row.id),
    text: row.text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
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
    const result = await db.query(`
      SELECT id, text, created_at
      FROM messages
      ORDER BY created_at ASC, id ASC
      LIMIT 500;
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
      return res.status(400).json({ error: 'Message text must be 1000 characters or less.' });
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
    broadcastMessage(message);
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
  sendSse(res, 'ready', { connected: true });
  clients.add(res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    res.end();
  });
});

const distDir = path.join(projectRoot, 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await initializeDatabase();

const server = app.listen(PORT, () => {
  console.log(`Message board server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_DIR}`);
});

function shutdown() {
  console.log('Shutting down...');
  for (const client of clients) {
    client.end();
  }
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
