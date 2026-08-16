import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-7;

const db = new PGlite(path.join(rootDir, '.pglite-data'));
const app = express();
const clients = new Set();
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
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

function normalizeColumn(row) {
  return {
    id: row.id,
    title: row.title,
    position: Number(row.position),
    cards: []
  };
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id)`);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
    }
  }
}

async function getBoard(client = db) {
  const [columnResult, cardResult] = await Promise.all([
    client.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    client.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC')
  ]);

  const columns = columnResult.rows.map(normalizeColumn);
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const row of cardResult.rows) {
    const card = normalizeCard(row);
    const column = byId.get(card.columnId);
    if (column) column.cards.push(card);
  }
  return { columns };
}

async function getCard(client, id) {
  const { rows } = await client.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [id]
  );
  return rows[0] ? normalizeCard(rows[0]) : null;
}

async function renormalizeColumn(client, columnId, excludedCardId = null) {
  const params = excludedCardId ? [columnId, excludedCardId] : [columnId];
  const exclusion = excludedCardId ? 'AND id <> $2' : '';
  const { rows } = await client.query(
    `SELECT id FROM cards WHERE column_id = $1 ${exclusion} ORDER BY position ASC, created_at ASC, id ASC`,
    params
  );

  for (let index = 0; index < rows.length; index += 1) {
    await client.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (index + 1) * POSITION_STEP,
      rows[index].id
    ]);
  }
}

function computePositionFromOrderedCards(orderedCards, beforeId, afterId) {
  let insertIndex = orderedCards.length;

  if (beforeId) {
    const beforeIndex = orderedCards.findIndex((card) => card.id === beforeId);
    if (beforeIndex >= 0) insertIndex = beforeIndex;
  } else if (afterId) {
    const afterIndex = orderedCards.findIndex((card) => card.id === afterId);
    if (afterIndex >= 0) insertIndex = afterIndex + 1;
  }

  const previous = orderedCards[insertIndex - 1] || null;
  const next = orderedCards[insertIndex] || null;

  let position;
  if (previous && next) {
    position = (Number(previous.position) + Number(next.position)) / 2;
  } else if (previous) {
    position = Number(previous.position) + POSITION_STEP;
  } else if (next) {
    position = Number(next.position) / 2;
  } else {
    position = POSITION_STEP;
  }

  if (
    !Number.isFinite(position) ||
    (previous && position <= Number(previous.position)) ||
    (next && position >= Number(next.position)) ||
    (previous && next && Math.abs(Number(next.position) - Number(previous.position)) < MIN_POSITION_GAP)
  ) {
    return { position: null, insertIndex };
  }

  return { position, insertIndex };
}

async function computeMovePosition(client, columnId, movingCardId, beforeId, afterId) {
  const { rows } = await client.query(
    `SELECT id, position, created_at
       FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId, movingCardId]
  );

  const orderedCards = rows.map((row) => ({ id: row.id, position: Number(row.position) }));
  let result = computePositionFromOrderedCards(orderedCards, beforeId, afterId);
  if (result.position !== null) return result.position;

  await renormalizeColumn(client, columnId, movingCardId);
  const refreshed = await client.query(
    `SELECT id, position, created_at
       FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId, movingCardId]
  );
  result = computePositionFromOrderedCards(
    refreshed.rows.map((row) => ({ id: row.id, position: Number(row.position) })),
    beforeId,
    afterId
  );

  if (result.position === null) {
    // Extremely defensive fallback: append to the end after renormalization.
    const max = refreshed.rows.reduce((highest, row) => Math.max(highest, Number(row.position)), 0);
    return max + POSITION_STEP;
  }

  return result.position;
}

function publish(eventName, payload) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
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

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');

  clients.add(res);
  req.on('close', () => {
    clients.delete(res);
  });
});

setInterval(() => {
  for (const client of clients) client.write(': heartbeat\n\n');
}, 25000).unref();

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const cleanText = String(text || '').trim();
    if (!columnId || !cleanText) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const result = await enqueueMutation(async () => {
      const txResult = await db.transaction(async (tx) => {
        const column = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const maxPosition = await tx.query(
          'SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1',
          [columnId]
        );
        const id = randomUUID();
        const position = Number(maxPosition.rows[0].max_position) + POSITION_STEP;
        await tx.query(
          'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
          [id, columnId, cleanText, position]
        );
        return getCard(tx, id);
      });

      const board = await getBoard();
      return { card: txResult, board };
    });

    publish('create', { type: 'create', card: result.card, columnId: result.card.columnId, board: result.board });
    res.status(201).json(result.card);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === id) return res.status(400).json({ error: 'beforeId cannot equal moved card id' });
    if (afterId && afterId === id) return res.status(400).json({ error: 'afterId cannot equal moved card id' });

    const result = await enqueueMutation(async () => {
      const movedCard = await db.transaction(async (tx) => {
        const existingCard = await getCard(tx, id);
        if (!existingCard) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }

        const column = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const position = await computeMovePosition(tx, columnId, id, beforeId, afterId);
        await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, id]);

        const duplicatePositions = await tx.query(
          `SELECT position, COUNT(*)::int AS count
             FROM cards
            WHERE column_id = $1
            GROUP BY position
           HAVING COUNT(*) > 1
            LIMIT 1`,
          [columnId]
        );
        if (duplicatePositions.rows.length > 0) {
          await renormalizeColumn(tx, columnId);
        }

        return getCard(tx, id);
      });

      const board = await getBoard();
      return { card: movedCard, board };
    });

    publish('move', { type: 'move', card: result.card, columnId: result.card.columnId, board: result.board });
    res.json(result.card);
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
