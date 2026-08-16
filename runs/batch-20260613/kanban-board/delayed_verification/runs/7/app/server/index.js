import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = process.env.PGLITE_DATA_DIR || './.pglite';
const POSITION_STEP = 1000;
const POSITION_EPSILON = 1e-9;

const db = new PGlite(DATA_DIR);
const app = express();
const clients = new Set();
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json());

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function inTransaction(fn) {
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id);');

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM "columns";');
  if (Number(rows[0].count) === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i += 1) {
      await db.query(
        'INSERT INTO "columns" (id, title, position) VALUES ($1, $2, $3);',
        [slug(defaults[i]), defaults[i], (i + 1) * POSITION_STEP]
      );
    }
  }
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
  const columnResult = await db.query('SELECT id, title, position FROM "columns" ORDER BY position, id;');
  const cardResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position, id;');

  const cardsByColumn = new Map();
  for (const card of cardResult.rows.map(normalizeCard)) {
    if (!cardsByColumn.has(card.columnId)) cardsByColumn.set(card.columnId, []);
    cardsByColumn.get(card.columnId).push(card);
  }

  return {
    columns: columnResult.rows.map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: cardsByColumn.get(column.id) || []
    }))
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of clients) sendSse(res, event, payload);
}

async function broadcastMutation(payload) {
  const board = await getBoard();
  broadcast('mutation', { ...payload, board });
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

app.get('/api/stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'connected', { ok: true, ts: Date.now() });

  const heartbeat = setInterval(() => sendSse(res, 'ping', { ts: Date.now() }), 25_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof columnId !== 'string') return res.status(400).json({ error: 'columnId is required' });
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });

    const card = await enqueueMutation(() => inTransaction(async (tx) => {
      const column = await tx.query('SELECT id FROM "columns" WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) {
        const error = new Error('Column not found');
        error.status = 404;
        throw error;
      }

      const max = await tx.query('SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1;', [columnId]);
      const position = Number(max.rows[0].max_position) + POSITION_STEP;
      const id = randomUUID();
      const inserted = await tx.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at;',
        [id, columnId, text.trim(), position]
      );
      return normalizeCard(inserted.rows[0]);
    }));

    res.status(201).json({ card });
    await broadcastMutation({ type: 'card-created', card, columnId: card.columnId });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId || typeof columnId !== 'string') return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === afterId) return res.status(400).json({ error: 'beforeId and afterId must differ' });

    const result = await enqueueMutation(() => inTransaction(async (tx) => {
      const existing = await tx.query('SELECT id, column_id FROM cards WHERE id = $1;', [cardId]);
      if (existing.rows.length === 0) {
        const error = new Error('Card not found');
        error.status = 404;
        throw error;
      }

      const column = await tx.query('SELECT id FROM "columns" WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) {
        const error = new Error('Column not found');
        error.status = 404;
        throw error;
      }

      const cardsResult = await tx.query(
        'SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position, id;',
        [columnId, cardId]
      );
      const targetCards = cardsResult.rows.map((row) => ({ id: row.id, position: Number(row.position) }));

      const afterIndex = afterId ? targetCards.findIndex((card) => card.id === afterId) : -1;
      const beforeIndex = beforeId ? targetCards.findIndex((card) => card.id === beforeId) : -1;
      if (afterId && afterIndex === -1) {
        const error = new Error('afterId is not in target column');
        error.status = 400;
        throw error;
      }
      if (beforeId && beforeIndex === -1) {
        const error = new Error('beforeId is not in target column');
        error.status = 400;
        throw error;
      }

      let insertIndex;
      if (beforeId) insertIndex = beforeIndex;
      else if (afterId) insertIndex = afterIndex + 1;
      else insertIndex = targetCards.length;

      if (beforeId && afterId && beforeIndex !== afterIndex + 1) {
        // The client observed stale neighbours. Honor beforeId and converge to a total order.
        insertIndex = beforeIndex;
      }

      const beforeCard = targetCards[insertIndex] || null;
      const afterCard = targetCards[insertIndex - 1] || null;
      let position;
      let renormalized = false;

      if (afterCard && beforeCard) {
        position = (afterCard.position + beforeCard.position) / 2;
        if (
          !Number.isFinite(position) ||
          position <= afterCard.position ||
          position >= beforeCard.position ||
          Math.abs(beforeCard.position - afterCard.position) < POSITION_EPSILON
        ) renormalized = true;
      } else if (afterCard) {
        position = afterCard.position + POSITION_STEP;
        if (!Number.isFinite(position) || position <= afterCard.position) renormalized = true;
      } else if (beforeCard) {
        position = beforeCard.position - POSITION_STEP;
        if (!Number.isFinite(position) || position >= beforeCard.position) renormalized = true;
      } else {
        position = POSITION_STEP;
      }

      if (!renormalized && targetCards.some((card) => Math.abs(card.position - position) < POSITION_EPSILON)) {
        renormalized = true;
      }

      if (!renormalized) {
        await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, cardId]);
      } else {
        const orderedIds = targetCards.map((card) => card.id);
        orderedIds.splice(insertIndex, 0, cardId);
        await tx.query('UPDATE cards SET column_id = $1 WHERE id = $2;', [columnId, cardId]);
        for (let i = 0; i < orderedIds.length; i += 1) {
          await tx.query('UPDATE cards SET position = $1 WHERE id = $2;', [(i + 1) * POSITION_STEP, orderedIds[i]]);
        }
      }

      const updated = await tx.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [cardId]);
      return { card: normalizeCard(updated.rows[0]), previousColumnId: existing.rows[0].column_id, renormalized };
    }));

    res.json(result);
    await broadcastMutation({
      type: 'card-moved',
      card: result.card,
      columnId: result.card.columnId,
      previousColumnId: result.previousColumnId,
      renormalized: result.renormalized
    });
  } catch (error) {
    next(error);
  }
});

if (existsSync('dist')) {
  app.use(express.static('dist'));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
