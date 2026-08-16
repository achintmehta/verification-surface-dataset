import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const db = new PGlite(path.join(rootDir, '.pglite'));

const app = express();
const port = process.env.PORT || 3000;
const POSITION_STEP = 1000;
const MIN_SAFE_GAP = 1e-7;
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json());

const sseClients = new Set();

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of sseClients) {
    sendSse(res, event, data);
  }
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

function enqueueMutation(work) {
  const next = mutationQueue.then(work, work);
  mutationQueue = next.catch(() => {});
  return next;
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id);');

  const existing = await query('SELECT COUNT(*)::int AS count FROM columns;');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i += 1) {
      await query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3);', [
        randomUUID(),
        defaults[i],
        (i + 1) * POSITION_STEP
      ]);
    }
  }
}

async function getBoard() {
  const columnsResult = await query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;');
  const cardsResult = await query(`
    SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;
  `);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const card of cardsResult.rows) {
    const column = byId.get(card.columnId);
    if (column) {
      column.cards.push(card);
    }
  }

  return { columns };
}

async function getCard(id) {
  const result = await query(
    'SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt" FROM cards WHERE id = $1;',
    [id]
  );
  return result.rows[0] ?? null;
}

async function ensureColumn(id) {
  const result = await query('SELECT id FROM columns WHERE id = $1;', [id]);
  return result.rows.length > 0;
}

function calculatePosition(afterPosition, beforePosition) {
  if (afterPosition != null && beforePosition != null) {
    return (Number(afterPosition) + Number(beforePosition)) / 2;
  }
  if (afterPosition != null) {
    return Number(afterPosition) + POSITION_STEP;
  }
  if (beforePosition != null) {
    const before = Number(beforePosition);
    return before > 0 ? before / 2 : before - POSITION_STEP;
  }
  return POSITION_STEP;
}

function positionNeedsRenormalization(position, afterPosition, beforePosition) {
  if (!Number.isFinite(position)) return true;
  if (afterPosition != null) {
    const after = Number(afterPosition);
    if (position <= after || Math.abs(position - after) < MIN_SAFE_GAP) return true;
  }
  if (beforePosition != null) {
    const before = Number(beforePosition);
    if (position >= before || Math.abs(before - position) < MIN_SAFE_GAP) return true;
  }
  if (afterPosition != null && beforePosition != null) {
    return Math.abs(Number(beforePosition) - Number(afterPosition)) < MIN_SAFE_GAP;
  }
  return false;
}

function insertCardIdInRequestedPlace(orderedIds, cardId, beforeId, afterId) {
  const ids = orderedIds.filter((id) => id !== cardId);

  let insertAt = ids.length;
  if (beforeId) {
    const beforeIndex = ids.indexOf(beforeId);
    if (beforeIndex >= 0) insertAt = beforeIndex;
  } else if (afterId) {
    const afterIndex = ids.indexOf(afterId);
    if (afterIndex >= 0) insertAt = afterIndex + 1;
  }

  ids.splice(insertAt, 0, cardId);
  return ids;
}

async function renormalizeColumn(columnId, preferredOrderIds = null) {
  const result = await query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;', [columnId]);
  const currentIds = result.rows.map((row) => row.id);
  const orderedIds = preferredOrderIds ?? currentIds;
  const currentSet = new Set(currentIds);
  const normalizedIds = orderedIds.filter((id) => currentSet.has(id));

  for (let i = 0; i < normalizedIds.length; i += 1) {
    await query('UPDATE cards SET position = $1 WHERE id = $2;', [(i + 1) * POSITION_STEP, normalizedIds[i]]);
  }
}

async function createCard(columnId, text) {
  const id = randomUUID();
  await query('BEGIN;');
  try {
    const columnExists = await ensureColumn(columnId);
    if (!columnExists) {
      const error = new Error('Column not found');
      error.status = 404;
      throw error;
    }

    const maxResult = await query('SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1;', [columnId]);
    const position = Number(maxResult.rows[0].max_position) + POSITION_STEP;
    await query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);', [
      id,
      columnId,
      text,
      position
    ]);
    await query('COMMIT;');
  } catch (error) {
    await query('ROLLBACK;');
    throw error;
  }

  return getCard(id);
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  await query('BEGIN;');
  let renormalized = false;
  try {
    const columnResult = await query('SELECT id FROM columns WHERE id = $1;', [columnId]);
    if (columnResult.rows.length === 0) {
      const error = new Error('Column not found');
      error.status = 404;
      throw error;
    }

    const cardResult = await query('SELECT id, column_id FROM cards WHERE id = $1;', [cardId]);
    if (cardResult.rows.length === 0) {
      const error = new Error('Card not found');
      error.status = 404;
      throw error;
    }

    if (beforeId === cardId) beforeId = null;
    if (afterId === cardId) afterId = null;

    const beforeResult = beforeId
      ? await query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2;', [beforeId, columnId])
      : { rows: [] };
    const afterResult = afterId
      ? await query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2;', [afterId, columnId])
      : { rows: [] };

    if (beforeId && beforeResult.rows.length === 0) {
      const error = new Error('beforeId is not in the target column');
      error.status = 400;
      throw error;
    }
    if (afterId && afterResult.rows.length === 0) {
      const error = new Error('afterId is not in the target column');
      error.status = 400;
      throw error;
    }

    const beforePosition = beforeResult.rows[0]?.position ?? null;
    const afterPosition = afterResult.rows[0]?.position ?? null;
    const position = calculatePosition(afterPosition, beforePosition);
    const collisionResult = await query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id <> $3 LIMIT 1;',
      [columnId, position, cardId]
    );
    const hasPositionCollision = collisionResult.rows.length > 0;

    if (hasPositionCollision || positionNeedsRenormalization(position, afterPosition, beforePosition)) {
      await query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, cardId]);
      const targetCards = await query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;', [columnId]);
      const preferredOrder = insertCardIdInRequestedPlace(
        targetCards.rows.map((row) => row.id),
        cardId,
        beforeId,
        afterId
      );
      await renormalizeColumn(columnId, preferredOrder);
      renormalized = true;
    } else {
      await query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, cardId]);
    }

    await query('COMMIT;');
  } catch (error) {
    await query('ROLLBACK;');
    throw error;
  }

  return { card: await getCard(cardId), renormalized };
}

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    if (!columnId || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const card = await enqueueMutation(() => createCard(columnId, text.trim()));
    const canonicalBoard = await getBoard();
    res.status(201).json({ card });
    broadcast('create', { card, columnId: card.columnId });
    broadcast('board', canonicalBoard);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const result = await enqueueMutation(() => moveCard(req.params.id, columnId, beforeId, afterId));
    const canonicalBoard = await getBoard();
    res.json({ card: result.card, renormalized: result.renormalized });
    broadcast('move', { card: result.card, columnId: result.card.columnId, renormalized: result.renormalized });
    broadcast('board', canonicalBoard);
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
  res.flushHeaders?.();

  sseClients.add(res);
  sendSse(res, 'connected', { ok: true });

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();

app.listen(port, () => {
  console.log(`Kanban API listening at http://localhost:${port}`);
});
