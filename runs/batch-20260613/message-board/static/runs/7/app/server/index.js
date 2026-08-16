import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.PGLITE_DATA_DIR ?? path.join(projectRoot, 'data', 'pglite');
const CLIENT_DIST = path.join(projectRoot, 'dist');

const app = express();
const db = new PGlite(DB_PATH);
const clients = new Set();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

function normalizeMessage(row) {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();

  return {
    id: Number(row.id),
    text: String(row.text),
    created_at: createdAt,
  };
}

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS messages_created_at_idx
    ON messages (created_at, id);
  `);
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

    const insertResult = await db.query(
      `
        INSERT INTO messages (text)
        VALUES ($1)
        RETURNING id, text, created_at;
      `,
      [text],
    );

    const message = normalizeMessage(insertResult.rows[0]);
    broadcastMessage(message);

    return res.status(201).json(message);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(': connected\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }

    return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await initializeDatabase();

app.listen(PORT, () => {
  console.log(`Message board API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DB_PATH}`);
});
