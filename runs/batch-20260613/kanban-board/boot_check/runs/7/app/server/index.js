import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(rootDir, '.pglite-data');
const POSITION_STEP = 1024;
const MIN_POSITION_GAP = 1e-9;

const app = express();
const db = new PGlite(DATA_DIR);
const clients = new Set();
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json());

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
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

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', POSITION_STEP],
      ['in-progress', 'In Progress', POSITION_STEP * 2],
      ['done', 'Done', POSITION_STEP * 3]
    ];
    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
    }
  }
}

async function waitForPendingMutations() {
  await mutationQueue.catch(() => {});
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await db.query(`
    SELECT id, column_id, text, position, created_at
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC
  `);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) {
      column.cards.push({
        id: card.id,
        columnId: card.column_id,
        text: card.text,
        position: Number(card.position),
        createdAt: card.created_at
      });
    }
  }

  return { columns };
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    try {
      sseSend(client, event, data);
    } catch {
      clients.delete(client);
    }
  }
}

async function broadcastBoard() {
  const board = await getBoard();
  broadcast('board', board);
  return board;
}

async function getColumnOrThrow(columnId) {
  const result = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (result.rows.length === 0) {
    const error = new Error('Column not found');
    error.status = 404;
    throw error;
  }
}

async function renormalizeColumn(columnId) {
  const result = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC', [columnId]);
  let index = 1;
  for (const row of result.rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [index * POSITION_STEP, row.id]);
    index += 1;
  }
}

async function hasUnsafeColumnOrdering(columnId) {
  const result = await db.query('SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC', [columnId]);
  let previous = null;
  for (const row of result.rows) {
    const current = Number(row.position);
    if (!Number.isFinite(current)) return true;
    if (previous !== null && Math.abs(current - previous) < MIN_POSITION_GAP) return true;
    previous = current;
  }
  return false;
}

async function computePosition(columnId, beforeId, afterId, movingCardId = null) {
  let before = null;
  let after = null;

  if (beforeId) {
    const result = await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
    if (result.rows.length === 0 || result.rows[0].id === movingCardId) {
      const error = new Error('beforeId must refer to a card in the destination column');
      error.status = 400;
      throw error;
    }
    before = Number(result.rows[0].position);
  }

  if (afterId) {
    const result = await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
    if (result.rows.length === 0 || result.rows[0].id === movingCardId) {
      const error = new Error('afterId must refer to a card in the destination column');
      error.status = 400;
      throw error;
    }
    after = Number(result.rows[0].position);
  }

  if (before !== null && after !== null && !(after < before)) {
    const error = new Error('afterId must be ordered before beforeId');
    error.status = 400;
    throw error;
  }

  let position;
  if (before !== null && after !== null) {
    position = (before + after) / 2;
  } else if (after !== null) {
    position = after + POSITION_STEP;
  } else if (before !== null) {
    position = before - POSITION_STEP;
  } else {
    const result = await db.query('SELECT MAX(position) AS max FROM cards WHERE column_id = $1 AND ($2::text IS NULL OR id <> $2)', [columnId, movingCardId]);
    const max = result.rows[0].max === null ? 0 : Number(result.rows[0].max);
    position = max + POSITION_STEP;
  }

  const tooTight = (before !== null && Math.abs(before - position) < MIN_POSITION_GAP) ||
    (after !== null && Math.abs(position - after) < MIN_POSITION_GAP);

  if (!Number.isFinite(position) || tooTight || position === before || position === after) {
    return null;
  }
  return position;
}

async function withTransaction(fn) {
  await db.exec('BEGIN');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
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
    await waitForPendingMutations();
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  sseSend(res, 'connected', { ok: true });
  try {
    await waitForPendingMutations();
    sseSend(res, 'board', await getBoard());
  } catch (error) {
    sseSend(res, 'error', { error: error.message });
  }

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    res.end();
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    const cleanText = String(text ?? '').trim();
    if (!columnId || !cleanText) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const result = await enqueueMutation(async () => {
      const card = await withTransaction(async () => {
        await getColumnOrThrow(columnId);
        const positionResult = await db.query('SELECT COALESCE(MAX(position), 0) + $2 AS position FROM cards WHERE column_id = $1', [columnId, POSITION_STEP]);
        const id = crypto.randomUUID();
        const position = Number(positionResult.rows[0].position);
        const inserted = await db.query(`
          INSERT INTO cards (id, column_id, text, position)
          VALUES ($1, $2, $3, $4)
          RETURNING id, column_id, text, position, created_at
        `, [id, columnId, cleanText, position]);
        return inserted.rows[0];
      });
      const canonical = {
        id: card.id,
        columnId: card.column_id,
        text: card.text,
        position: Number(card.position),
        createdAt: card.created_at
      };
      broadcast('card-created', { card: canonical, columnId: canonical.columnId });
      const board = await broadcastBoard();
      return { canonical, board };
    });

    res.status(201).json({ card: result.canonical, board: result.board });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    if (beforeId && afterId && beforeId === afterId) {
      return res.status(400).json({ error: 'beforeId and afterId must be different' });
    }

    const result = await enqueueMutation(async () => {
      const move = await withTransaction(async () => {
        await getColumnOrThrow(columnId);
        const existing = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [cardId]);
        if (existing.rows.length === 0) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }
        const oldColumnId = existing.rows[0].column_id;

        let position = await computePosition(columnId, beforeId, afterId, cardId);
        if (position === null) {
          await renormalizeColumn(columnId);
          position = await computePosition(columnId, beforeId, afterId, cardId);
        }
        if (position === null) {
          const error = new Error('Could not compute a safe position');
          error.status = 409;
          throw error;
        }

        const updated = await db.query(`
          UPDATE cards
          SET column_id = $1, position = $2
          WHERE id = $3
          RETURNING id, column_id, text, position, created_at
        `, [columnId, position, cardId]);

        let renormalized = false;
        if (await hasUnsafeColumnOrdering(columnId)) {
          await renormalizeColumn(columnId);
          renormalized = true;
        }
        if (oldColumnId !== columnId && await hasUnsafeColumnOrdering(oldColumnId)) {
          await renormalizeColumn(oldColumnId);
          renormalized = true;
        }

        const canonicalResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
        return { card: canonicalResult.rows[0] ?? updated.rows[0], oldColumnId, renormalized };
      });

      const canonical = {
        id: move.card.id,
        columnId: move.card.column_id,
        text: move.card.text,
        position: Number(move.card.position),
        createdAt: move.card.created_at
      };
      broadcast('card-moved', {
        card: canonical,
        columnId: canonical.columnId,
        oldColumnId: move.oldColumnId,
        renormalized: move.renormalized
      });
      const board = await broadcastBoard();
      return { canonical, board };
    });

    res.json({ card: result.canonical, board: result.board });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
