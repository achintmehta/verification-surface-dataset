import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const POSITION_STEP = 1000;
const POSITION_EPSILON = 1e-9;

const dataDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite');
fs.mkdirSync(dataDir, { recursive: true });

const db = new PGlite(dataDir);
const app = express();

app.use(cors());
app.use(express.json({ limit: '128kb' }));

const clients = new Map();
let nextEventId = 1;
let transactionTail = Promise.resolve();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function rowNumber(row, key) {
  return typeof row[key] === 'number' ? row[key] : Number(row[key]);
}

function publicCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: rowNumber(row, 'position'),
    createdAt: row.created_at,
  };
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position, id);
    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  await db.query(
    `INSERT INTO columns (id, title, position)
     VALUES
       ('todo', 'To Do', 1000),
       ('in-progress', 'In Progress', 2000),
       ('done', 'Done', 3000)
     ON CONFLICT (id) DO NOTHING`
  );
}

async function queryBoardRows() {
  const columnsResult = await db.query(
    `SELECT id, title, position
     FROM columns
     ORDER BY position ASC, id ASC`
  );

  const cardsResult = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards
     ORDER BY column_id ASC, position ASC, created_at ASC, id ASC`
  );

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: rowNumber(column, 'position'),
    cards: [],
  }));

  const byColumn = new Map(columns.map((column) => [column.id, column]));
  for (const cardRow of cardsResult.rows) {
    const column = byColumn.get(cardRow.column_id);
    if (column) column.cards.push(publicCard(cardRow));
  }

  return { columns };
}

async function getBoard() {
  // Public snapshots wait for already queued mutations so no client observes partial state.
  const pending = transactionTail;
  await pending;
  return queryBoardRows();
}

async function runTransactionNow(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    throw error;
  }
}

async function withTransaction(fn) {
  // PGLite exposes one embedded database connection; serialize write transactions.
  const previous = transactionTail;
  const run = previous.then(() => runTransactionNow(fn));
  transactionTail = run.catch(() => {});
  return run;
}

async function ensureColumn(columnId) {
  const result = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (result.rows.length === 0) throw httpError(404, 'Column not found');
}

async function getCardById(cardId) {
  const result = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards
     WHERE id = $1`,
    [cardId]
  );
  return result.rows[0] || null;
}

async function getBoundaryCard(boundaryId, columnId, movingCardId) {
  if (!boundaryId || boundaryId === movingCardId) return null;
  const result = await db.query(
    `SELECT id, position
     FROM cards
     WHERE id = $1 AND column_id = $2`,
    [boundaryId, columnId]
  );
  return result.rows[0] || null;
}

async function renormalizeColumnExistingOrder(columnId) {
  const result = await db.query(
    `SELECT id
     FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );

  for (let index = 0; index < result.rows.length; index += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (index + 1) * POSITION_STEP,
      result.rows[index].id,
    ]);
  }
}

async function renormalizeColumnWithIntent(columnId, movingCardId, beforeId, afterId) {
  const result = await db.query(
    `SELECT id
     FROM cards
     WHERE column_id = $1 AND id <> $2
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId, movingCardId]
  );

  const order = result.rows.map((row) => row.id);
  let insertAt = order.length;

  if (beforeId) {
    const beforeIndex = order.indexOf(beforeId);
    if (beforeIndex !== -1) insertAt = beforeIndex;
  } else if (afterId) {
    const afterIndex = order.indexOf(afterId);
    if (afterIndex !== -1) insertAt = afterIndex + 1;
  }

  order.splice(insertAt, 0, movingCardId);

  for (let index = 0; index < order.length; index += 1) {
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      (index + 1) * POSITION_STEP,
      order[index],
    ]);
  }
}

async function columnNeedsRenormalization(columnId) {
  const result = await db.query(
    `SELECT position
     FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );

  let previous = null;
  for (const row of result.rows) {
    const position = rowNumber(row, 'position');
    if (!Number.isFinite(position)) return true;
    if (previous !== null && position - previous <= POSITION_EPSILON) return true;
    previous = position;
  }
  return false;
}

function positionIsExhausted(position, lower, upper) {
  if (!Number.isFinite(position)) return true;
  if (lower !== null && Math.abs(position - lower) <= POSITION_EPSILON) return true;
  if (upper !== null && Math.abs(upper - position) <= POSITION_EPSILON) return true;
  return false;
}

async function moveCardAtomically(cardId, columnId, beforeId, afterId) {
  return withTransaction(async () => {
    await ensureColumn(columnId);

    const existingCard = await getCardById(cardId);
    if (!existingCard) throw httpError(404, 'Card not found');
    const sourceColumnId = existingCard.column_id;

    const before = await getBoundaryCard(beforeId, columnId, cardId);
    const after = await getBoundaryCard(afterId, columnId, cardId);

    const beforePosition = before ? rowNumber(before, 'position') : null;
    const afterPosition = after ? rowNumber(after, 'position') : null;

    let newPosition;
    let mustRenormalizeWithIntent = false;

    if (after && before) {
      if (afterPosition >= beforePosition) {
        mustRenormalizeWithIntent = true;
      } else {
        newPosition = (afterPosition + beforePosition) / 2;
      }
    } else if (after) {
      newPosition = afterPosition + POSITION_STEP;
    } else if (before) {
      newPosition = beforePosition - POSITION_STEP;
    } else {
      const maxResult = await db.query(
        `SELECT MAX(position) AS max_position
         FROM cards
         WHERE column_id = $1 AND id <> $2`,
        [columnId, cardId]
      );
      const maxPosition = maxResult.rows[0]?.max_position;
      newPosition = maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
    }

    if (!mustRenormalizeWithIntent && positionIsExhausted(newPosition, afterPosition, beforePosition)) {
      mustRenormalizeWithIntent = true;
    }

    if (mustRenormalizeWithIntent) {
      await renormalizeColumnWithIntent(columnId, cardId, before?.id || beforeId || null, after?.id || afterId || null);
    } else {
      await db.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3`,
        [columnId, newPosition, cardId]
      );

      if (await columnNeedsRenormalization(columnId)) {
        await renormalizeColumnExistingOrder(columnId);
      }
    }

    if (sourceColumnId !== columnId && await columnNeedsRenormalization(sourceColumnId)) {
      await renormalizeColumnExistingOrder(sourceColumnId);
    }

    const movedCard = await getCardById(cardId);
    return { card: publicCard(movedCard), board: await queryBoardRows() };
  });
}

function sendSse(res, event) {
  const id = nextEventId++;
  res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  for (const [clientId, res] of clients.entries()) {
    try {
      sendSse(res, event);
    } catch (error) {
      clients.delete(clientId);
      try {
        res.end();
      } catch {
        // no-op
      }
    }
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', asyncRoute(async (req, res) => {
  res.json(await getBoard());
}));

app.post('/api/cards', asyncRoute(async (req, res) => {
  const columnId = String(req.body?.columnId || '').trim();
  const text = String(req.body?.text || '').trim();

  if (!columnId) throw httpError(400, 'columnId is required');
  if (!text) throw httpError(400, 'Card text is required');

  const { card, board } = await withTransaction(async () => {
    await ensureColumn(columnId);
    const maxResult = await db.query(
      `SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1`,
      [columnId]
    );
    const maxPosition = maxResult.rows[0]?.max_position;
    const position = maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
    const id = randomUUID();

    await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)`,
      [id, columnId, text, position]
    );

    if (await columnNeedsRenormalization(columnId)) {
      await renormalizeColumnExistingOrder(columnId);
    }

    const createdCard = await getCardById(id);
    return { card: publicCard(createdCard), board: await queryBoardRows() };
  });

  const event = { type: 'card:create', card, columnId: card.columnId, board, sentAt: new Date().toISOString() };
  broadcast(event);
  res.status(201).json({ card, board });
}));

app.patch('/api/cards/:id/move', asyncRoute(async (req, res) => {
  const cardId = req.params.id;
  const columnId = String(req.body?.columnId || '').trim();
  const beforeId = req.body?.beforeId ? String(req.body.beforeId) : null;
  const afterId = req.body?.afterId ? String(req.body.afterId) : null;

  if (!columnId) throw httpError(400, 'columnId is required');

  const { card, board } = await moveCardAtomically(cardId, columnId, beforeId, afterId);
  const event = { type: 'card:move', card, columnId: card.columnId, board, sentAt: new Date().toISOString() };
  broadcast(event);
  res.json({ card, board });
}));

app.get('/api/stream', asyncRoute(async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const clientId = randomUUID();
  clients.set(clientId, res);

  sendSse(res, { type: 'connected', board: await getBoard(), sentAt: new Date().toISOString() });

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
      clients.delete(clientId);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(clientId);
  });
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${dataDir}`);
});
