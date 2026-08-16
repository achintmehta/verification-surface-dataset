import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const POSITION_STEP = 1024;
const MIN_GAP = 1e-7;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const db = new PGlite(process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pglite-data'));
const clients = new Set();
let mutationQueue = Promise.resolve();

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function tx(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS "columns" (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES "columns"(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query('CREATE INDEX IF NOT EXISTS cards_column_position_idx ON cards(column_id, position, created_at, id);');

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM "columns";');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do'],
      ['in-progress', 'In Progress'],
      ['done', 'Done']
    ];
    for (let i = 0; i < defaults.length; i++) {
      await db.query('INSERT INTO "columns" (id, title, position) VALUES ($1, $2, $3);', [defaults[i][0], defaults[i][1], (i + 1) * POSITION_STEP]);
    }
  }
}

function normalizeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at
  };
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM "columns" ORDER BY position ASC, id ASC;');
  const cardsResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;');
  const byColumn = new Map();
  for (const row of cardsResult.rows) {
    const card = normalizeCard(row);
    if (!byColumn.has(card.columnId)) byColumn.set(card.columnId, []);
    byColumn.get(card.columnId).push(card);
  }
  return {
    columns: columnsResult.rows.map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: byColumn.get(column.id) || []
    }))
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of clients) sendSse(res, event, payload);
}

async function makePayload(type, card, extra = {}) {
  return { type, card, columnId: card?.columnId, board: await getBoard(), ...extra };
}

async function renormalizeColumn(columnId) {
  const result = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;', [columnId]);
  for (let i = 0; i < result.rows.length; i++) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2;', [(i + 1) * POSITION_STEP, result.rows[i].id]);
  }
}

async function hasColumnCollision(columnId) {
  const result = await db.query(
    'SELECT position, COUNT(*)::int AS count FROM cards WHERE column_id = $1 GROUP BY position HAVING COUNT(*) > 1 LIMIT 1;',
    [columnId]
  );
  return result.rows.length > 0;
}

async function insertOrderAndRenormalize(cardId, targetColumnId, insertionIndex, orderedWithoutMoving) {
  const finalOrder = [...orderedWithoutMoving];
  finalOrder.splice(insertionIndex, 0, { id: cardId });
  for (let i = 0; i < finalOrder.length; i++) {
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [targetColumnId, (i + 1) * POSITION_STEP, finalOrder[i].id]);
  }
}

function computeInsertionIndex(cards, beforeId, afterId) {
  if (afterId) {
    const afterIndex = cards.findIndex((card) => card.id === afterId);
    if (afterIndex === -1) throw Object.assign(new Error('afterId is not in the target column'), { status: 400 });
    return afterIndex + 1;
  }
  if (beforeId) {
    const beforeIndex = cards.findIndex((card) => card.id === beforeId);
    if (beforeIndex === -1) throw Object.assign(new Error('beforeId is not in the target column'), { status: 400 });
    return beforeIndex;
  }
  return cards.length;
}

function computeFractionalPosition(cards, insertionIndex) {
  const previous = cards[insertionIndex - 1]?.position;
  const next = cards[insertionIndex]?.position;
  if (previous == null && next == null) return POSITION_STEP;
  if (previous == null) return Number(next) / 2;
  if (next == null) return Number(previous) + POSITION_STEP;
  const middle = (Number(previous) + Number(next)) / 2;
  if (!Number.isFinite(middle) || middle === Number(previous) || middle === Number(next) || Math.abs(Number(next) - Number(previous)) < MIN_GAP) return null;
  return middle;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/board', async (_req, res, next) => {
  try { res.json(await getBoard()); } catch (error) { next(error); }
});

app.get('/api/stream', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    clients.add(res);
    sendSse(res, 'connected', { type: 'connected' });
    sendSse(res, 'board', { type: 'board', board: await getBoard() });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  } catch (error) { next(error); }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    const trimmed = text.trim().slice(0, 500);
    const card = await enqueueMutation(() => tx(async () => {
      const column = await db.query('SELECT id FROM "columns" WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });
      const positionResult = await db.query('SELECT COALESCE(MAX(position), 0) + $1 AS position FROM cards WHERE column_id = $2;', [POSITION_STEP, columnId]);
      const id = randomUUID();
      await db.query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);', [id, columnId, trimmed, Number(positionResult.rows[0].position)]);
      const inserted = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [id]);
      return normalizeCard(inserted.rows[0]);
    }));
    const payload = await makePayload('card_created', card);
    broadcast('card_created', payload);
    broadcast('board', { type: 'board', board: payload.board });
    res.status(201).json({ card, board: payload.board });
  } catch (error) { next(error); }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === cardId) return res.status(400).json({ error: 'beforeId cannot be the moved card' });
    if (afterId && afterId === cardId) return res.status(400).json({ error: 'afterId cannot be the moved card' });

    const { card, renormalized } = await enqueueMutation(() => tx(async () => {
      const targetColumn = await db.query('SELECT id FROM "columns" WHERE id = $1;', [columnId]);
      if (targetColumn.rows.length === 0) throw Object.assign(new Error('Target column not found'), { status: 404 });
      const moving = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [cardId]);
      if (moving.rows.length === 0) throw Object.assign(new Error('Card not found'), { status: 404 });

      const ordered = await db.query(
        'SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC;',
        [columnId, cardId]
      );
      const cards = ordered.rows.map((row) => ({ id: row.id, position: Number(row.position) }));
      const insertionIndex = computeInsertionIndex(cards, beforeId, afterId);
      const newPosition = computeFractionalPosition(cards, insertionIndex);
      let didRenormalize = false;

      if (newPosition == null) {
        await insertOrderAndRenormalize(cardId, columnId, insertionIndex, cards);
        didRenormalize = true;
      } else {
        await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, newPosition, cardId]);
        if (await hasColumnCollision(columnId)) {
          await insertOrderAndRenormalize(cardId, columnId, insertionIndex, cards);
          didRenormalize = true;
        }
      }

      const updated = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [cardId]);
      return { card: normalizeCard(updated.rows[0]), renormalized: didRenormalize };
    }));

    const payload = await makePayload('card_moved', card, { renormalized });
    broadcast('card_moved', payload);
    broadcast('board', { type: 'board', board: payload.board });
    res.json({ card, board: payload.board, renormalized });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(__dirname, '..', 'client')));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Kanban server listening on http://localhost:${PORT}`));
}).catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
