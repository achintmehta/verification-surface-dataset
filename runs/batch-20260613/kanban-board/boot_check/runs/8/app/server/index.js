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
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'pgdata');
const POSITION_STEP = 1000;
const POSITION_EPSILON = 1e-9;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DATA_DIR);
const clients = new Set();
let mutationQueue = Promise.resolve();

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function query(sql, params = []) {
  return db.query(sql, params);
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query('CREATE INDEX IF NOT EXISTS cards_column_position_idx ON cards(column_id, position, created_at, id);');

  const existing = await query('SELECT COUNT(*)::int AS count FROM columns;');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3);', [id, title, position]);
    }
  }
}

function normalizeCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function getBoard() {
  const [columnsResult, cardsResult] = await Promise.all([
    query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;'),
    query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;')
  ]);

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: []
  }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const cardRow of cardsResult.rows) {
    const column = byId.get(cardRow.column_id);
    if (column) column.cards.push(normalizeCard(cardRow));
  }

  return { columns };
}

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const client of clients) {
    try {
      sseWrite(client, event, payload);
    } catch {
      clients.delete(client);
    }
  }
}

async function broadcastBoard(reason, extra = {}) {
  const board = await getBoard();
  broadcast('board-state', { type: 'board-state', reason, board, ...extra });
}

async function renormalizeColumn(columnId) {
  const rows = (await query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId]
  )).rows;

  for (let i = 0; i < rows.length; i += 1) {
    await query('UPDATE cards SET position = $1 WHERE id = $2;', [(i + 1) * POSITION_STEP, rows[i].id]);
  }
}

async function getNeighborPositions(columnId, movingCardId, beforeId, afterId) {
  const cards = (await query(
    'SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId, movingCardId || '']
  )).rows.map((row) => ({ id: row.id, position: Number(row.position) }));

  let before = null;
  let after = null;

  if (beforeId) before = cards.find((card) => card.id === beforeId) || null;
  if (afterId) after = cards.find((card) => card.id === afterId) || null;

  if (!beforeId && afterId) {
    const afterIndex = cards.findIndex((card) => card.id === afterId);
    before = afterIndex >= 0 ? cards[afterIndex + 1] || null : null;
  }

  if (!afterId && beforeId) {
    const beforeIndex = cards.findIndex((card) => card.id === beforeId);
    after = beforeIndex > 0 ? cards[beforeIndex - 1] || null : null;
  }

  return { before, after, cards };
}

function computePosition({ before, after, cards }) {
  if (after && before) return (after.position + before.position) / 2;
  if (after) return after.position + POSITION_STEP;
  if (before) return before.position - POSITION_STEP;
  const max = cards.reduce((value, card) => Math.max(value, card.position), 0);
  return max + POSITION_STEP;
}

function hasBadPosition(position, before, after, cards) {
  if (!Number.isFinite(position)) return true;
  if (before && Math.abs(before.position - position) < POSITION_EPSILON) return true;
  if (after && Math.abs(after.position - position) < POSITION_EPSILON) return true;
  if (before && after && Math.abs(before.position - after.position) < POSITION_EPSILON) return true;
  return cards.some((card) => Math.abs(card.position - position) < POSITION_EPSILON);
}

async function canonicalCard(id) {
  const result = await query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [id]);
  return normalizeCard(result.rows[0]);
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

app.post('/api/cards', async (req, res, next) => {
  try {
    const result = await enqueueMutation(async () => {
      const columnId = String(req.body.columnId || '');
      const text = String(req.body.text || '').trim();
      if (!columnId || !text) {
        const error = new Error('columnId and text are required');
        error.status = 400;
        throw error;
      }

      const column = await query('SELECT id FROM columns WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) {
        const error = new Error('Unknown column');
        error.status = 404;
        throw error;
      }

      const maxResult = await query('SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1;', [columnId]);
      const position = Number(maxResult.rows[0].max_position) + POSITION_STEP;
      const id = randomUUID();
      const inserted = await query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at;',
        [id, columnId, text, position]
      );
      const card = normalizeCard(inserted.rows[0]);
      broadcast('card-created', { type: 'card-created', card });
      await broadcastBoard('card-created', { card });
      return card;
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const result = await enqueueMutation(async () => {
      const cardId = req.params.id;
      const columnId = String(req.body.columnId || '');
      const beforeId = req.body.beforeId || null;
      const afterId = req.body.afterId || null;

      if (!columnId) {
        const error = new Error('columnId is required');
        error.status = 400;
        throw error;
      }

      try {
        await query('BEGIN;');
        const cardResult = await query('SELECT id, column_id FROM cards WHERE id = $1;', [cardId]);
        if (cardResult.rows.length === 0) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }
        const columnResult = await query('SELECT id FROM columns WHERE id = $1;', [columnId]);
        if (columnResult.rows.length === 0) {
          const error = new Error('Unknown column');
          error.status = 404;
          throw error;
        }

        let neighbors = await getNeighborPositions(columnId, cardId, beforeId, afterId);
        let position = computePosition(neighbors);
        let renormalized = false;

        if (hasBadPosition(position, neighbors.before, neighbors.after, neighbors.cards)) {
          await renormalizeColumn(columnId);
          renormalized = true;
          neighbors = await getNeighborPositions(columnId, cardId, beforeId, afterId);
          position = computePosition(neighbors);
        }

        const updated = await query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING id, column_id, text, position, created_at;',
          [columnId, position, cardId]
        );
        await query('COMMIT;');

        return { card: normalizeCard(updated.rows[0]), renormalized };
      } catch (error) {
        try { await query('ROLLBACK;'); } catch {}
        throw error;
      }
    });

    broadcast('card-moved', { type: 'card-moved', card: result.card, renormalized: result.renormalized });
    await broadcastBoard('card-moved', { card: result.card, renormalized: result.renormalized });
    res.json(result.card);
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
  sseWrite(res, 'connected', { type: 'connected' });
  try {
    sseWrite(res, 'board-state', { type: 'board-state', reason: 'connected', board: await getBoard() });
  } catch {}

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error && !res.headersSent) {
      res.status(404).send('Kanban board frontend is available in development via Vite, or after running npm run build.');
    }
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
