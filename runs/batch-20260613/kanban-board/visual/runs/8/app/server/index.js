import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(ROOT_DIR, 'data', 'pglite');
const PORT = Number(process.env.PORT || 3001);
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 0.000001;

mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const db = new PGlite(DATA_DIR);
const clients = new Set();
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function withMutationLock(work) {
  const run = mutationQueue.then(work, work);
  mutationQueue = run.catch(() => {});
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

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id);
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  const count = Number(countResult.rows[0]?.count || 0);
  if (count === 0) {
    await db.query(
      `INSERT INTO columns (id, title, position) VALUES
        ($1, 'To Do', 1000),
        ($2, 'In Progress', 2000),
        ($3, 'Done', 3000)`,
      ['todo', 'in-progress', 'done'],
    );
  }
}

async function boardState() {
  const [columnsResult, cardsResult] = await Promise.all([
    db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    db.query(`
      SELECT id, column_id, column_id AS "columnId", text, position, created_at AS "createdAt"
      FROM cards
      ORDER BY column_id ASC, position ASC, id ASC
    `),
  ]);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  const seenCards = new Set();

  for (const card of cardsResult.rows) {
    if (seenCards.has(card.id)) continue;
    seenCards.add(card.id);
    const column = byId.get(card.columnId || card.column_id);
    if (column) column.cards.push(normalizeCard(card));
  }

  return { columns };
}

function normalizeCard(card) {
  return {
    id: card.id,
    columnId: card.columnId || card.column_id,
    column_id: card.columnId || card.column_id,
    text: card.text,
    position: Number(card.position),
    createdAt: card.createdAt || card.created_at,
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

async function broadcastBoard(event, extra = {}) {
  const board = await boardState();
  broadcast(event, { ...extra, board });
  return board;
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function coerceId(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function computeFractionalPosition(previousPosition, nextPosition) {
  const hasPrevious = previousPosition !== null && previousPosition !== undefined;
  const hasNext = nextPosition !== null && nextPosition !== undefined;

  if (hasPrevious && hasNext) return (Number(previousPosition) + Number(nextPosition)) / 2;
  if (hasPrevious) return Number(previousPosition) + POSITION_STEP;
  if (hasNext) return Number(nextPosition) - POSITION_STEP;
  return POSITION_STEP;
}

function positionNeedsRenormalization(position, previousPosition, nextPosition, targetCards) {
  if (!Number.isFinite(position)) return true;
  if (previousPosition !== null && previousPosition !== undefined && position <= Number(previousPosition)) return true;
  if (nextPosition !== null && nextPosition !== undefined && position >= Number(nextPosition)) return true;
  if (previousPosition !== null && previousPosition !== undefined && Math.abs(position - Number(previousPosition)) < MIN_POSITION_GAP) return true;
  if (nextPosition !== null && nextPosition !== undefined && Math.abs(Number(nextPosition) - position) < MIN_POSITION_GAP) return true;
  return targetCards.some((card) => Math.abs(Number(card.position) - position) < MIN_POSITION_GAP);
}

function findInsertIndex(targetCards, beforeId, afterId) {
  if (afterId) {
    const afterIndex = targetCards.findIndex((card) => card.id === afterId);
    if (afterIndex === -1) throw Object.assign(new Error('afterId is not in the target column'), { status: 400 });
    return afterIndex + 1;
  }
  if (beforeId) {
    const beforeIndex = targetCards.findIndex((card) => card.id === beforeId);
    if (beforeIndex === -1) throw Object.assign(new Error('beforeId is not in the target column'), { status: 400 });
    return beforeIndex;
  }
  return targetCards.length;
}

async function moveCardTransaction(cardId, columnId, beforeId, afterId) {
  await db.exec('BEGIN');
  try {
    const [cardResult, columnResult, targetResult] = await Promise.all([
      db.query('SELECT id, column_id, column_id AS "columnId", text, position, created_at AS "createdAt" FROM cards WHERE id = $1', [cardId]),
      db.query('SELECT id FROM columns WHERE id = $1', [columnId]),
      db.query(
        'SELECT id, column_id, column_id AS "columnId", text, position, created_at AS "createdAt" FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, id ASC',
        [columnId, cardId],
      ),
    ]);

    if (cardResult.rows.length === 0) throw Object.assign(new Error('Card not found'), { status: 404 });
    if (columnResult.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });

    if (beforeId && beforeId === cardId) beforeId = null;
    if (afterId && afterId === cardId) afterId = null;

    const movingCard = normalizeCard(cardResult.rows[0]);
    const targetCards = targetResult.rows.map(normalizeCard);
    const insertIndex = findInsertIndex(targetCards, beforeId, afterId);
    const previous = targetCards[insertIndex - 1] || null;
    const next = targetCards[insertIndex] || null;
    const newPosition = computeFractionalPosition(previous?.position, next?.position);

    let canonicalCard;
    let renormalized = false;

    if (positionNeedsRenormalization(newPosition, previous?.position, next?.position, targetCards)) {
      renormalized = true;
      const reordered = [...targetCards];
      reordered.splice(insertIndex, 0, { ...movingCard, columnId, column_id: columnId });
      for (let index = 0; index < reordered.length; index += 1) {
        const position = (index + 1) * POSITION_STEP;
        const current = reordered[index];
        await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, current.id]);
        if (current.id === cardId) canonicalCard = { ...current, columnId, column_id: columnId, position };
      }
    } else {
      const updateResult = await db.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING id, column_id, column_id AS "columnId", text, position, created_at AS "createdAt"`,
        [columnId, newPosition, cardId],
      );
      canonicalCard = normalizeCard(updateResult.rows[0]);
    }

    await db.exec('COMMIT');
    return { card: canonicalCard, renormalized };
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await boardState());
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    const columnId = coerceId(req.body?.columnId);
    if (!columnId) return jsonError(res, 400, 'columnId is required');
    if (!text) return jsonError(res, 400, 'text is required');

    const result = await withMutationLock(async () => {
      const columnResult = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (columnResult.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });

      const maxResult = await db.query('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1', [columnId]);
      const maxPosition = maxResult.rows[0]?.max_position;
      const position = maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
      const insertResult = await db.query(
        `INSERT INTO cards (id, column_id, text, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id, column_id, column_id AS "columnId", text, position, created_at AS "createdAt"`,
        [randomUUID(), columnId, text, position],
      );
      const card = normalizeCard(insertResult.rows[0]);
      const board = await broadcastBoard('card:create', { card, columnId });
      return { card, board };
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = String(req.params.id);
    const columnId = coerceId(req.body?.columnId);
    let beforeId = coerceId(req.body?.beforeId);
    let afterId = coerceId(req.body?.afterId);
    if (!columnId) return jsonError(res, 400, 'columnId is required');

    const result = await withMutationLock(async () => {
      const { card, renormalized } = await moveCardTransaction(cardId, columnId, beforeId, afterId);
      const board = await broadcastBoard('card:move', { card, columnId, renormalized });
      return { card, board, renormalized };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);

  try {
    sendSse(res, 'board', { board: await boardState() });
  } catch (error) {
    sendSse(res, 'error', { error: error.message });
  }

  const keepAlive = setInterval(() => {
    if (!res.destroyed) res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
    res.end();
  });
});

const distDir = path.join(ROOT_DIR, 'client', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) res.status(404).send('Frontend has not been built. Run npm run client:build or use npm run dev.');
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kanban server listening on http://localhost:${PORT}`);
      console.log(`PGLite data directory: ${DATA_DIR}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
