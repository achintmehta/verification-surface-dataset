import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pglite');
const POSITION_STEP = 1000;
const MIN_GAP = 1e-7;

const app = express();
app.use(cors());
app.use(express.json());

mkdirSync(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);
const clients = new Set();
let mutationQueue = Promise.resolve();

function enqueueMutation(fn) {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.catch(() => {});
  return next;
}

async function initDb() {
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (count.rows[0].count === 0) {
    await db.query(
      `INSERT INTO columns (id, title, position) VALUES
        ($1, 'To Do', 1000),
        ($2, 'In Progress', 2000),
        ($3, 'Done', 3000)`,
      ['todo', 'in-progress', 'done']
    );
  }
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
  return { columns };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of clients) {
    try {
      sendSse(res, event, payload);
    } catch {
      clients.delete(res);
    }
  }
}

async function broadcastBoard(event, extra = {}) {
  const board = await getBoard();
  broadcast(event, { ...extra, board });
  return board;
}

function normalizeBoundaryId(id) {
  return typeof id === 'string' && id.trim() ? id : null;
}

function computePosition(prev, next) {
  if (prev && next) return (Number(prev.position) + Number(next.position)) / 2;
  if (prev) return Number(prev.position) + POSITION_STEP;
  if (next) return Number(next.position) - POSITION_STEP;
  return POSITION_STEP;
}

function positionIsSafe(position, prev, next) {
  if (!Number.isFinite(position)) return false;
  if (prev && !(position > Number(prev.position)) || next && !(position < Number(next.position))) return false;
  if (prev && Math.abs(position - Number(prev.position)) < MIN_GAP) return false;
  if (next && Math.abs(Number(next.position) - position) < MIN_GAP) return false;
  return true;
}

async function renormalizeColumn(tx, columnId, orderedIds) {
  let canonical = null;
  for (let i = 0; i < orderedIds.length; i += 1) {
    const position = (i + 1) * POSITION_STEP;
    const result = await tx.query(
      'UPDATE cards SET position = $1 WHERE id = $2 AND column_id = $3 RETURNING id, column_id, text, position, created_at',
      [position, orderedIds[i], columnId]
    );
    if (result.rows[0]) canonical = result.rows[0];
  }
  return canonical;
}

async function withTransaction(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  clients.add(res);

  try {
    sendSse(res, 'sync', { board: await getBoard() });
  } catch {
    clients.delete(res);
  }

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    if (!columnId || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const card = await enqueueMutation(async () => {
      const inserted = await withTransaction(async (tx) => {
        const column = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const max = await tx.query('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1', [columnId]);
        const position = max.rows[0].max_position == null ? POSITION_STEP : Number(max.rows[0].max_position) + POSITION_STEP;
        const result = await tx.query(
          'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at',
          [randomUUID(), columnId, text.trim(), position]
        );
        return result.rows[0];
      });
      await broadcastBoard('card:create', { card: inserted });
      return inserted;
    });

    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const columnId = req.body?.columnId;
    const beforeId = normalizeBoundaryId(req.body?.beforeId);
    const afterId = normalizeBoundaryId(req.body?.afterId);

    if (!columnId || beforeId === cardId || afterId === cardId || (beforeId && beforeId === afterId)) {
      return res.status(400).json({ error: 'Valid columnId and optional distinct beforeId/afterId are required' });
    }

    const canonical = await enqueueMutation(async () => {
      const moved = await withTransaction(async (tx) => {
        const cardResult = await tx.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
        if (cardResult.rows.length === 0) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }
        const columnResult = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (columnResult.rows.length === 0) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const targetCardsResult = await tx.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
          [columnId, cardId]
        );
        const targetCards = targetCardsResult.rows;
        const ids = targetCards.map((card) => card.id);

        let insertIndex;
        const beforeIndex = beforeId ? ids.indexOf(beforeId) : -1;
        const afterIndex = afterId ? ids.indexOf(afterId) : -1;
        if (beforeId && beforeIndex === -1) {
          const error = new Error('beforeId is not in target column');
          error.status = 400;
          throw error;
        }
        if (afterId && afterIndex === -1) {
          const error = new Error('afterId is not in target column');
          error.status = 400;
          throw error;
        }
        if (beforeId && afterId && afterIndex !== beforeIndex - 1) {
          // Concurrent edits may make both hints no longer adjacent. Preserve intent using beforeId as the stronger boundary.
          insertIndex = beforeIndex;
        } else if (beforeId) {
          insertIndex = beforeIndex;
        } else if (afterId) {
          insertIndex = afterIndex + 1;
        } else {
          insertIndex = targetCards.length;
        }

        const prev = insertIndex > 0 ? targetCards[insertIndex - 1] : null;
        const next = insertIndex < targetCards.length ? targetCards[insertIndex] : null;
        const newPosition = computePosition(prev, next);

        if (positionIsSafe(newPosition, prev, next)) {
          const update = await tx.query(
            'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING id, column_id, text, position, created_at',
            [columnId, newPosition, cardId]
          );
          return { card: update.rows[0], renormalized: false };
        }

        await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, newPosition, cardId]);
        const orderedIds = [...ids];
        orderedIds.splice(insertIndex, 0, cardId);
        await renormalizeColumn(tx, columnId, orderedIds);
        const result = await tx.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
        return { card: result.rows[0], renormalized: true };
      });
      await broadcastBoard('card:move', { card: moved.card, renormalized: moved.renormalized });
      return moved.card;
    });

    res.json(canonical);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGlite data directory: ${DATA_DIR}`);
});
