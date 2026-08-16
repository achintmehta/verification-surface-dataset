import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'data', 'kanban-pglite');
const PORT = process.env.PORT || 3000;
const POSITION_STEP = 1000;
const EPSILON = 1e-9;

await mkdir(dataDir, { recursive: true });
const db = new PGlite(dataDir);

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch((error) => console.error('Queued write failed:', error));
  return run;
}

function id() {
  return crypto.randomUUID();
}

async function initDatabase() {
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    const defaultColumns = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000],
    ];
    for (const [columnId, title, position] of defaultColumns) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [columnId, title, position]);
    }
  }
}

function mapCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC',
  );

  const cardsByColumn = new Map();
  for (const row of cardsResult.rows) {
    const card = mapCard(row);
    if (!cardsByColumn.has(card.columnId)) cardsByColumn.set(card.columnId, []);
    cardsByColumn.get(card.columnId).push(card);
  }

  return {
    columns: columnsResult.rows.map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: cardsByColumn.get(column.id) || [],
    })),
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const client of clients) {
    sendSse(client, event, payload);
  }
}

async function broadcastBoard(reason, payload = {}) {
  const board = await getBoard();
  broadcast('board', { reason, board, ...payload });
}

async function columnExists(columnId) {
  const result = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function renormalizeColumn(columnId) {
  const result = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId],
  );

  for (let index = 0; index < result.rows.length; index += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, result.rows[index].id]);
  }
}

async function shouldRenormalize(columnId) {
  const result = await db.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId],
  );

  let previous = null;
  for (const row of result.rows) {
    const current = Number(row.position);
    if (!Number.isFinite(current)) return true;
    if (previous !== null && Math.abs(current - previous) < EPSILON) return true;
    previous = current;
  }
  return false;
}

async function getCanonicalCard(cardId) {
  const result = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
  if (result.rows.length === 0) return null;
  return mapCard(result.rows[0]);
}

async function computePosition(columnId, movingCardId, beforeId, afterId) {
  let before = null;
  let after = null;

  if (beforeId) {
    const result = await db.query(
      'SELECT id, position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
      [beforeId, columnId, movingCardId],
    );
    before = result.rows[0] || null;
  }

  if (afterId) {
    const result = await db.query(
      'SELECT id, position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
      [afterId, columnId, movingCardId],
    );
    after = result.rows[0] || null;
  }

  if (before && after && Number(after.position) < Number(before.position)) {
    return (Number(after.position) + Number(before.position)) / 2;
  }

  if (after && !before) {
    return Number(after.position) + POSITION_STEP;
  }

  if (before && !after) {
    return Number(before.position) - POSITION_STEP;
  }

  const maxResult = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1 AND id <> $2',
    [columnId, movingCardId],
  );
  return Number(maxResult.rows[0].max_position || 0) + POSITION_STEP;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  clients.add(res);
  sendSse(res, 'connected', { ok: true, clientCount: clients.size });
  sendSse(res, 'board', { reason: 'connected', board: await getBoard() });

  const heartbeat = setInterval(() => {
    sendSse(res, 'ping', { at: Date.now() });
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const cleanText = String(text || '').trim();
    if (!columnId || !cleanText) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const result = await enqueueWrite(async () => {
      if (!(await columnExists(columnId))) {
        const error = new Error('Column not found');
        error.status = 404;
        throw error;
      }

      const cardId = id();
      await db.exec('BEGIN');
      try {
        const maxResult = await db.query('SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1', [columnId]);
        const position = Number(maxResult.rows[0].max_position || 0) + POSITION_STEP;
        await db.query(
          'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
          [cardId, columnId, cleanText, position],
        );
        if (await shouldRenormalize(columnId)) await renormalizeColumn(columnId);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }

      const card = await getCanonicalCard(cardId);
      return { card, board: await getBoard() };
    });

    broadcast('card-created', { card: result.card, columnId: result.card.columnId });
    broadcast('board', { reason: 'card-created', card: result.card, board: result.board });
    res.status(201).json(result.card);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });

    const result = await enqueueWrite(async () => {
      if (!(await columnExists(columnId))) {
        const error = new Error('Column not found');
        error.status = 404;
        throw error;
      }

      let oldColumnId = null;
      await db.exec('BEGIN');
      try {
        const existing = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [cardId]);
        if (existing.rows.length === 0) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }
        oldColumnId = existing.rows[0].column_id;

        const position = await computePosition(columnId, cardId, beforeId, afterId);
        await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, cardId]);

        if (await shouldRenormalize(columnId)) await renormalizeColumn(columnId);
        if (oldColumnId !== columnId && (await shouldRenormalize(oldColumnId))) await renormalizeColumn(oldColumnId);

        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }

      const card = await getCanonicalCard(cardId);
      return { card, oldColumnId, board: await getBoard() };
    });

    broadcast('card-moved', {
      card: result.card,
      columnId: result.card.columnId,
      oldColumnId: result.oldColumnId,
    });
    broadcast('board', { reason: 'card-moved', card: result.card, oldColumnId: result.oldColumnId, board: result.board });
    res.json(result.card);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDatabase();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
