import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'pglite-data');
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-7;

const app = express();
const db = new PGlite(DATA_DIR);
const clients = new Set();

app.use(cors());
app.use(express.json());

// PGlite runs in-process, but HTTP handlers can still overlap at await points. This
// tiny mutex serializes write transactions so position calculations remain stable.
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

async function initializeDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
    }
  }
}

async function getBoardState() {
  const [columnResult, cardResult] = await Promise.all([
    db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    db.query(`
      SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
      FROM cards
      ORDER BY column_id ASC, position ASC, created_at ASC, id ASC
    `)
  ]);

  const cardsByColumn = new Map();
  for (const card of cardResult.rows) {
    if (!cardsByColumn.has(card.columnId)) cardsByColumn.set(card.columnId, []);
    cardsByColumn.get(card.columnId).push(card);
  }

  return {
    columns: columnResult.rows.map((column) => ({
      ...column,
      cards: cardsByColumn.get(column.id) || []
    }))
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const client of clients) {
    try {
      sendSse(client, event, payload);
    } catch {
      clients.delete(client);
    }
  }
}

async function columnExists(columnId) {
  const result = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function getCard(id) {
  const result = await db.query(
    `SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt" FROM cards WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getBoundaryPosition(cardId, columnId, movingCardId) {
  if (!cardId) return null;
  const result = await db.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
    [cardId, columnId, movingCardId || '']
  );
  return result.rows.length ? Number(result.rows[0].position) : null;
}

async function getColumnExtremes(columnId, movingCardId) {
  const result = await db.query(
    `SELECT MIN(position) AS min, MAX(position) AS max, COUNT(*)::int AS count
     FROM cards
     WHERE column_id = $1 AND id <> $2`,
    [columnId, movingCardId || '']
  );
  const row = result.rows[0];
  return {
    min: row.min === null ? null : Number(row.min),
    max: row.max === null ? null : Number(row.max),
    count: Number(row.count)
  };
}

async function computePosition(columnId, beforeId, afterId, movingCardId = '') {
  const [beforePos, afterPos, extremes] = await Promise.all([
    getBoundaryPosition(beforeId, columnId, movingCardId),
    getBoundaryPosition(afterId, columnId, movingCardId),
    getColumnExtremes(columnId, movingCardId)
  ]);

  if (afterPos !== null && beforePos !== null && afterPos < beforePos) {
    return (afterPos + beforePos) / 2;
  }
  if (afterPos !== null) return afterPos + POSITION_STEP;
  if (beforePos !== null) return beforePos - POSITION_STEP;
  if (extremes.count > 0) return Number(extremes.max) + POSITION_STEP;
  return POSITION_STEP;
}

async function needsRenormalization(columnId) {
  const result = await db.query(
    `SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let previous = null;
  for (const row of result.rows) {
    const position = Number(row.position);
    if (!Number.isFinite(position)) return true;
    if (previous !== null && position - previous < MIN_POSITION_GAP) return true;
    previous = position;
  }
  return false;
}

async function renormalizeColumn(columnId) {
  const result = await db.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let index = 1;
  for (const row of result.rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [index * POSITION_STEP, row.id]);
    index += 1;
  }
}

async function transaction(fn) {
  await db.exec('BEGIN');
  try {
    const value = await fn();
    await db.exec('COMMIT');
    return value;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (req, res, next) => {
  try {
    res.json(await getBoardState());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'connected', { ok: true, clientCount: clients.size });

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const cleanText = String(text || '').trim();
    if (!columnId || !cleanText) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const result = await withWriteLock(() => transaction(async () => {
      if (!(await columnExists(columnId))) {
        const error = new Error('Column not found');
        error.status = 404;
        throw error;
      }

      const id = randomUUID();
      const position = await computePosition(columnId, null, null, id);
      await db.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
        [id, columnId, cleanText, position]
      );
      if (await needsRenormalization(columnId)) await renormalizeColumn(columnId);
      return getCard(id);
    }));

    const board = await getBoardState();
    const payload = { type: 'created', card: result, columnId: result.columnId, board };
    broadcast('mutation', payload);
    res.status(201).json(payload);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === afterId) return res.status(400).json({ error: 'beforeId and afterId must differ' });

    const movedCard = await withWriteLock(() => transaction(async () => {
      const current = await getCard(cardId);
      if (!current) {
        const error = new Error('Card not found');
        error.status = 404;
        throw error;
      }
      if (!(await columnExists(columnId))) {
        const error = new Error('Column not found');
        error.status = 404;
        throw error;
      }

      const previousColumnId = current.columnId;
      const position = await computePosition(columnId, beforeId, afterId, cardId);
      await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, cardId]);
      if (await needsRenormalization(columnId)) await renormalizeColumn(columnId);
      if (previousColumnId !== columnId && await needsRenormalization(previousColumnId)) {
        await renormalizeColumn(previousColumnId);
      }
      return getCard(cardId);
    }));

    const board = await getBoardState();
    const payload = { type: 'moved', card: movedCard, columnId: movedCard.columnId, board };
    broadcast('mutation', payload);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

// Serve the built frontend in production/start mode if it exists.
app.use(express.static(path.join(rootDir, 'client/dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'client/dist/index.html'), (error) => {
    if (error) next();
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

await initializeDatabase();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
