import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), 'data', 'pglite');
const POSITION_STEP = 1000;
const POSITION_EPSILON = 1e-9;

const db = new PGlite(DB_PATH);
const app = express();

app.use(cors());
app.use(express.json());

const clients = new Map();
let nextClientId = 1;

// A tiny in-process mutation queue. PGLite is embedded in this Node process, and
// serializing write transactions keeps ordering logic deterministic under bursts
// of concurrent HTTP requests.
let mutationQueue = Promise.resolve();
function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);');

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM columns;');
  if ((countResult.rows[0]?.count ?? 0) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3);', [id, title, position]);
    }
  }
}

function toCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at
  };
}

async function getBoard(queryable = db) {
  const columnsResult = await queryable.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;');
  const cardsResult = await queryable.query(`
    SELECT id, column_id, text, position, created_at
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;
  `);

  const cardsByColumn = new Map();
  for (const card of cardsResult.rows.map(toCard)) {
    const list = cardsByColumn.get(card.columnId) ?? [];
    list.push(card);
    cardsByColumn.set(card.columnId, list);
  }

  return {
    columns: columnsResult.rows.map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: cardsByColumn.get(column.id) ?? []
    }))
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const [, res] of clients) {
    sendSse(res, event, payload);
  }
}

async function renormalizeColumn(columnId, queryable = db) {
  const result = await queryable.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId]
  );

  let position = POSITION_STEP;
  for (const row of result.rows) {
    await queryable.query('UPDATE cards SET position = $1 WHERE id = $2;', [position, row.id]);
    position += POSITION_STEP;
  }
}

async function getOrderedCards(columnId, movingCardId, queryable = db) {
  const result = await queryable.query(
    `SELECT id, position
     FROM cards
     WHERE column_id = $1 AND id <> $2
     ORDER BY position ASC, created_at ASC, id ASC;`,
    [columnId, movingCardId]
  );
  return result.rows.map((row) => ({ id: row.id, position: Number(row.position) }));
}

function chooseNeighborPositions(orderedCards, beforeId, afterId) {
  let beforeIndex = beforeId ? orderedCards.findIndex((card) => card.id === beforeId) : -1;
  let afterIndex = afterId ? orderedCards.findIndex((card) => card.id === afterId) : -1;

  // Clients send intent, not authority. If a concurrent mutation made one of the
  // neighbor ids stale, preserve intent as closely as possible using the neighbor
  // that still exists; if both are missing, append to the end.
  if (beforeIndex >= 0 && afterIndex >= 0 && afterIndex >= beforeIndex) {
    afterIndex = beforeIndex - 1;
  }

  if (beforeIndex >= 0) {
    return {
      afterPosition: beforeIndex > 0 ? orderedCards[beforeIndex - 1].position : null,
      beforePosition: orderedCards[beforeIndex].position
    };
  }

  if (afterIndex >= 0) {
    return {
      afterPosition: orderedCards[afterIndex].position,
      beforePosition: afterIndex < orderedCards.length - 1 ? orderedCards[afterIndex + 1].position : null
    };
  }

  return {
    afterPosition: orderedCards.length ? orderedCards[orderedCards.length - 1].position : null,
    beforePosition: null
  };
}

function midpointPosition(afterPosition, beforePosition) {
  if (afterPosition !== null && beforePosition !== null) return (afterPosition + beforePosition) / 2;
  if (afterPosition !== null) return afterPosition + POSITION_STEP;
  if (beforePosition !== null) return beforePosition - POSITION_STEP;
  return POSITION_STEP;
}

async function calculatePosition({ columnId, beforeId, afterId, movingCardId, queryable = db }) {
  let orderedCards = await getOrderedCards(columnId, movingCardId, queryable);
  let { afterPosition, beforePosition } = chooseNeighborPositions(orderedCards, beforeId, afterId);
  let position = midpointPosition(afterPosition, beforePosition);

  const exhausted =
    !Number.isFinite(position) ||
    (afterPosition !== null && Math.abs(position - afterPosition) <= POSITION_EPSILON) ||
    (beforePosition !== null && Math.abs(beforePosition - position) <= POSITION_EPSILON) ||
    (afterPosition !== null && beforePosition !== null && !(afterPosition < position && position < beforePosition));

  if (!exhausted) return { position, renormalized: false };

  await renormalizeColumn(columnId, queryable);
  orderedCards = await getOrderedCards(columnId, movingCardId, queryable);
  ({ afterPosition, beforePosition } = chooseNeighborPositions(orderedCards, beforeId, afterId));
  position = midpointPosition(afterPosition, beforePosition);

  return { position, renormalized: true };
}

async function committedTransaction(work) {
  await db.query('BEGIN;');
  try {
    const result = await work(db);
    await db.query('COMMIT;');
    return result;
  } catch (error) {
    await db.query('ROLLBACK;');
    throw error;
  }
}

function notFound(res, message) {
  return res.status(404).json({ error: message });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, clients: clients.size });
});

app.get('/api/board', async (req, res, next) => {
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

  const clientId = nextClientId++;
  clients.set(clientId, res);

  sendSse(res, 'connected', { clientId });
  try {
    sendSse(res, 'board', await getBoard());
  } catch (error) {
    sendSse(res, 'error', { error: 'Could not load board state' });
  }

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    const columnId = String(req.body?.columnId ?? '');

    if (!text) return res.status(400).json({ error: 'Card text is required' });
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });

    const result = await enqueueMutation(async () => {
      return committedTransaction(async (tx) => {
        const columnResult = await tx.query('SELECT id FROM columns WHERE id = $1;', [columnId]);
        if (!columnResult.rows.length) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const positionResult = await tx.query(
          'SELECT COALESCE(MAX(position), 0) + $2 AS position FROM cards WHERE column_id = $1;',
          [columnId, POSITION_STEP]
        );
        const id = randomUUID();
        const position = Number(positionResult.rows[0].position);
        const insertResult = await tx.query(
          'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at;',
          [id, columnId, text, position]
        );
        return { card: toCard(insertResult.rows[0]) };
      });
    });

    const board = await getBoard();
    const payload = { type: 'create', card: result.card, columnId: result.card.columnId, board };
    broadcast('create', payload);
    res.status(201).json(payload);
  } catch (error) {
    if (error.status === 404) return notFound(res, error.message);
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const columnId = String(req.body?.columnId ?? '');
    const beforeId = req.body?.beforeId || null;
    const afterId = req.body?.afterId || null;

    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === afterId) return res.status(400).json({ error: 'beforeId and afterId must differ' });

    const result = await enqueueMutation(async () => {
      return committedTransaction(async (tx) => {
        const columnResult = await tx.query('SELECT id FROM columns WHERE id = $1;', [columnId]);
        if (!columnResult.rows.length) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const cardResult = await tx.query('SELECT id, column_id FROM cards WHERE id = $1;', [cardId]);
        if (!cardResult.rows.length) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }

        const { position, renormalized } = await calculatePosition({
          columnId,
          beforeId,
          afterId,
          movingCardId: cardId,
          queryable: tx
        });

        await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, cardId]);

        const duplicateResult = await tx.query(
          `SELECT position, COUNT(*)::int AS count
           FROM cards
           WHERE column_id = $1
           GROUP BY position
           HAVING COUNT(*) > 1
           LIMIT 1;`,
          [columnId]
        );

        let wasRenormalized = renormalized;
        if (duplicateResult.rows.length) {
          await renormalizeColumn(columnId, tx);
          wasRenormalized = true;
        }

        const updateResult = await tx.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
          [cardId]
        );
        return { card: toCard(updateResult.rows[0]), renormalized: wasRenormalized };
      });
    });

    const board = await getBoard();
    const payload = {
      type: 'move',
      card: result.card,
      columnId: result.card.columnId,
      renormalized: result.renormalized,
      board
    };
    broadcast(result.renormalized ? 'renormalize' : 'move', payload);
    res.json(payload);
  } catch (error) {
    if (error.status === 404) return notFound(res, error.message);
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DB_PATH}`);
});
