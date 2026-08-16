import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const dataDir = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'data', 'pglite');
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const db = new PGlite(dataDir);
const sseClients = new Set();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

function normalizeMessage(row) {
  return {
    id: Number(row.id),
    text: row.text,
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL CHECK (char_length(trim(text)) > 0 AND char_length(text) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS messages_created_at_id_idx
    ON messages (created_at ASC, id ASC);
  `);
}

function writeSseEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastMessage(message) {
  for (const client of sseClients) {
    writeSseEvent(client, 'message', message);
  }
}

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/api/messages', async (_request, response, next) => {
  try {
    const result = await db.query(`
      SELECT id, text, created_at
      FROM messages
      ORDER BY created_at ASC, id ASC;
    `);

    response.json(result.rows.map(normalizeMessage));
  } catch (error) {
    next(error);
  }
});

app.post('/api/messages', async (request, response, next) => {
  try {
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';

    if (!text) {
      return response.status(400).json({ error: 'Message text is required.' });
    }

    if (text.length > 1000) {
      return response.status(400).json({ error: 'Message text must be 1000 characters or fewer.' });
    }

    const result = await db.query(
      `
        INSERT INTO messages (text)
        VALUES ($1)
        RETURNING id, text, created_at;
      `,
      [text],
    );

    const message = normalizeMessage(result.rows[0]);
    broadcastMessage(message);

    return response.status(201).json(message);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/stream', (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  response.flushHeaders?.();
  writeSseEvent(response, 'connected', { ok: true });
  sseClients.add(response);

  const heartbeat = setInterval(() => {
    response.write(': heartbeat\n\n');
  }, 25_000);

  request.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
    response.end();
  });
});

if (isProduction) {
  app.use(express.static(distDir));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error.' });
});

await initializeDatabase();

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  console.log(`PGLite data directory: ${dataDir}`);
});
