import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;
const GAP = 1000;
const EPSILON = 1e-9;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(rootDir, '.pglite'));
const clients = new Set();
let transactionQueue = Promise.resolve();
let transactionDepth = 0;

async function q(sql, params = []) {
  return db.query(sql, params);
}

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await q('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);');

  const count = Number((await q('SELECT COUNT(*)::int AS count FROM columns;')).rows[0].count);
  if (count === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await q('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3);', [id, title, position]);
    }
  }
}

function normalizeBoardRows(columnRows, cardRows) {
  const columns = columnRows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardRows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
  return { columns };
}

async function getBoardState() {
  if (transactionDepth === 0) await transactionQueue;
  const [columnsResult, cardsResult] = await Promise.all([
    q('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;'),
    q('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;')
  ]);
  return normalizeBoardRows(columnsResult.rows, cardsResult.rows);
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  for (const res of clients) {
    try {
      sendSse(res, event);
    } catch {
      clients.delete(res);
    }
  }
}

async function broadcastWithBoard(event) {
  const board = await getBoardState();
  broadcast({ ...event, board });
}

function positionBetween(afterPosition, beforePosition) {
  let candidate;
  if (afterPosition != null && beforePosition != null) {
    candidate = (Number(afterPosition) + Number(beforePosition)) / 2;
  } else if (afterPosition != null) {
    candidate = Number(afterPosition) + GAP;
  } else if (beforePosition != null) {
    candidate = Number(beforePosition) - GAP;
  } else {
    candidate = GAP;
  }

  const bad = !Number.isFinite(candidate)
    || (afterPosition != null && candidate <= Number(afterPosition))
    || (beforePosition != null && candidate >= Number(beforePosition))
    || (afterPosition != null && Math.abs(candidate - Number(afterPosition)) < EPSILON)
    || (beforePosition != null && Math.abs(Number(beforePosition) - candidate) < EPSILON);

  return bad ? null : candidate;
}

async function getCanonicalCard(cardId) {
  const result = await q(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
    [cardId]
  );
  return result.rows[0] || null;
}

async function cardInColumn(cardId, columnId, movingCardId) {
  if (!cardId) return null;
  const result = await q(
    'SELECT id, position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3;',
    [cardId, columnId, movingCardId]
  );
  return result.rows[0] || null;
}

async function computeMovePosition(columnId, beforeId, afterId, movingCardId) {
  const [before, after] = await Promise.all([
    cardInColumn(beforeId, columnId, movingCardId),
    cardInColumn(afterId, columnId, movingCardId)
  ]);

  if (beforeId && !before) throw Object.assign(new Error('beforeId is not in the target column'), { status: 400 });
  if (afterId && !after) throw Object.assign(new Error('afterId is not in the target column'), { status: 400 });

  // If the client drops at the end and does not provide an afterId, use the current max.
  if (!before && !after) {
    const maxResult = await q(
      'SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1 AND id <> $2;',
      [columnId, movingCardId]
    );
    const max = maxResult.rows[0].max_position;
    return { position: max == null ? GAP : Number(max) + GAP, needsRenormalize: false };
  }

  const candidate = positionBetween(after?.position ?? null, before?.position ?? null);
  if (candidate == null) return { position: null, needsRenormalize: true };

  const collision = await q(
    'SELECT id FROM cards WHERE column_id = $1 AND id <> $2 AND position = $3 LIMIT 1;',
    [columnId, movingCardId, candidate]
  );
  return { position: candidate, needsRenormalize: collision.rows.length > 0 };
}

async function renormalizeColumnWithMovedCard(columnId, movingCardId, beforeId, afterId) {
  const cardResult = await q(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
    [movingCardId]
  );
  const moving = cardResult.rows[0];
  if (!moving) throw Object.assign(new Error('Card not found'), { status: 404 });

  const result = await q(
    'SELECT id FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId, movingCardId]
  );
  const ids = result.rows.map((row) => row.id);

  let insertAt = ids.length;
  if (beforeId) {
    const idx = ids.indexOf(beforeId);
    if (idx === -1) throw Object.assign(new Error('beforeId is not in the target column'), { status: 400 });
    insertAt = idx;
  } else if (afterId) {
    const idx = ids.indexOf(afterId);
    if (idx === -1) throw Object.assign(new Error('afterId is not in the target column'), { status: 400 });
    insertAt = idx + 1;
  }

  ids.splice(insertAt, 0, movingCardId);
  for (let i = 0; i < ids.length; i += 1) {
    await q('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, (i + 1) * GAP, ids[i]]);
  }
}

async function transact(work) {
  const run = async () => {
    transactionDepth += 1;
    try {
      await q('BEGIN;');
      try {
        const value = await work();
        await q('COMMIT;');
        return value;
      } catch (error) {
        await q('ROLLBACK;');
        throw error;
      }
    } finally {
      transactionDepth -= 1;
    }
  };

  const next = transactionQueue.then(run, run);
  transactionQueue = next.catch(() => {});
  return next;
}

app.get('/api/board', async (_req, res, next) => {
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
  sendSse(res, { type: 'connected', board: await getBoardState() });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const trimmed = String(text || '').trim();
    if (!columnId || !trimmed) return res.status(400).json({ error: 'columnId and text are required' });

    const cardId = randomUUID();
    const card = await transact(async () => {
      const column = await q('SELECT id FROM columns WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });

      const maxResult = await q('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1;', [columnId]);
      const position = maxResult.rows[0].max_position == null ? GAP : Number(maxResult.rows[0].max_position) + GAP;
      await q('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);', [cardId, columnId, trimmed, position]);
      return getCanonicalCard(cardId);
    });

    res.status(201).json({ card });
    await broadcastWithBoard({ type: 'create', card, columnId: card.column_id });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === cardId) return res.status(400).json({ error: 'A card cannot be before itself' });
    if (afterId && afterId === cardId) return res.status(400).json({ error: 'A card cannot be after itself' });
    if (beforeId && afterId && beforeId === afterId) return res.status(400).json({ error: 'beforeId and afterId must differ' });

    const { card, renormalized } = await transact(async () => {
      const column = await q('SELECT id FROM columns WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });
      const existing = await q('SELECT id FROM cards WHERE id = $1;', [cardId]);
      if (existing.rows.length === 0) throw Object.assign(new Error('Card not found'), { status: 404 });

      const { position, needsRenormalize } = await computeMovePosition(columnId, beforeId, afterId, cardId);
      if (needsRenormalize) {
        await q('UPDATE cards SET column_id = $1 WHERE id = $2;', [columnId, cardId]);
        await renormalizeColumnWithMovedCard(columnId, cardId, beforeId, afterId);
      } else {
        await q('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, cardId]);
      }

      return { card: await getCanonicalCard(cardId), renormalized: needsRenormalize };
    });

    res.json({ card, renormalized });
    await broadcastWithBoard({ type: 'move', card, columnId: card.column_id, renormalized });
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
});
