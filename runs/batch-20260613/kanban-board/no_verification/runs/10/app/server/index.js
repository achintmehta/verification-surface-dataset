import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(ROOT_DIR, 'data', 'pglite');
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-9;

const db = new PGlite(DB_DIR);
const app = express();
const sseClients = new Set();

// PGlite runs embedded in this process. Serialising writes avoids overlapping
// BEGIN/COMMIT blocks and makes every mutation appear atomic to readers/SSE.
let mutationQueue = Promise.resolve();
function serializeMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

app.use(cors());
app.use(express.json({ limit: '128kb' }));

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "columns" (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES "columns"(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (column_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position, created_at, id);
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM "columns"');
  if (existing.rows[0].count === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i += 1) {
      await db.query(
        'INSERT INTO "columns" (id, title, position) VALUES ($1, $2, $3)',
        [slug(defaults[i]), defaults[i], (i + 1) * POSITION_STEP]
      );
    }
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function withTransaction(fn) {
  await db.exec('BEGIN');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures; the original error is what callers need.
    }
    throw error;
  }
}

async function readBoard() {
  const columnsResult = await db.query(
    'SELECT id, title, position FROM "columns" ORDER BY position ASC, id ASC'
  );
  const cardsResult = await db.query(`
    SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC
  `);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.columnId);
    if (column) column.cards.push(card);
  }
  return { columns };
}

async function getBoard() {
  return serializeMutation(readBoard);
}

async function getCard(id) {
  const result = await db.query(
    `SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
     FROM cards WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventPayload(type, payload) {
  return JSON.stringify({ type, ...payload, emittedAt: new Date().toISOString() });
}

function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${eventPayload(type, payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastMutation(type, payload) {
  broadcast(type, payload);
}

async function ensureColumnExists(columnId) {
  const result = await db.query('SELECT id FROM "columns" WHERE id = $1', [columnId]);
  if (result.rows.length === 0) throw httpError(404, `Column '${columnId}' was not found`);
}

function calculateInsertion(cards, movingCardId, beforeId, afterId) {
  const ids = new Set(cards.map((card) => card.id));

  if (beforeId === movingCardId) beforeId = null;
  if (afterId === movingCardId) afterId = null;

  if (beforeId && !ids.has(beforeId)) {
    throw httpError(400, `beforeId '${beforeId}' is not in the target column`);
  }
  if (afterId && !ids.has(afterId)) {
    throw httpError(400, `afterId '${afterId}' is not in the target column`);
  }

  let index;
  if (beforeId) {
    index = cards.findIndex((card) => card.id === beforeId);
  } else if (afterId) {
    index = cards.findIndex((card) => card.id === afterId) + 1;
  } else {
    index = cards.length;
  }

  index = Math.max(0, Math.min(cards.length, index));
  const previous = cards[index - 1] || null;
  const next = cards[index] || null;

  let position;
  let shouldRenormalize = false;
  if (previous && next) {
    position = (Number(previous.position) + Number(next.position)) / 2;
    shouldRenormalize =
      !Number.isFinite(position) ||
      position <= Number(previous.position) ||
      position >= Number(next.position) ||
      Math.abs(Number(next.position) - Number(previous.position)) < MIN_POSITION_GAP;
  } else if (previous) {
    position = Number(previous.position) + POSITION_STEP;
    shouldRenormalize = !Number.isFinite(position) || position <= Number(previous.position);
  } else if (next) {
    position = Number(next.position) - POSITION_STEP;
    shouldRenormalize = !Number.isFinite(position) || position >= Number(next.position);
  } else {
    position = POSITION_STEP;
  }

  return { index, position, shouldRenormalize };
}

async function renormalizeExistingColumn(columnId) {
  const result = await db.query(
    `SELECT id
     FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  const temporaryBase = -1 * (Date.now() + Math.floor(Math.random() * 1_000_000));
  for (let i = 0; i < result.rows.length; i += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [temporaryBase - i, result.rows[i].id]);
  }
  for (let i = 0; i < result.rows.length; i += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, result.rows[i].id]);
  }
}

async function renormalizeColumnWithMovedCard({ columnId, movingCardId, orderedCards, insertIndex }) {
  const canonicalOrder = [...orderedCards];
  canonicalOrder.splice(insertIndex, 0, { id: movingCardId, moving: true });

  // Move every affected row out of the canonical positive range first. This
  // avoids transient UNIQUE(column_id, position) conflicts while swapping order
  // inside one transaction (for example C moving between A and B while B still
  // owns the final position C needs).
  const temporaryBase = -1 * (Date.now() + Math.floor(Math.random() * 1_000_000));
  for (let i = 0; i < canonicalOrder.length; i += 1) {
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      temporaryBase - i,
      canonicalOrder[i].id,
    ]);
  }

  for (let i = 0; i < canonicalOrder.length; i += 1) {
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      (i + 1) * POSITION_STEP,
      canonicalOrder[i].id,
    ]);
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

app.post('/api/cards', async (req, res, next) => {
  try {
    const columnId = normalizeId(req.body?.columnId);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!columnId) throw httpError(400, 'columnId is required');
    if (!text) throw httpError(400, 'text is required');

    const result = await serializeMutation(() =>
      withTransaction(async () => {
        await ensureColumnExists(columnId);
        const positionResult = await db.query(
          'SELECT COALESCE(MAX(position), 0) + $1 AS position FROM cards WHERE column_id = $2',
          [POSITION_STEP, columnId]
        );
        const id = randomUUID();
        const position = Number(positionResult.rows[0].position);
        try {
          await db.query(
            'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
            [id, columnId, text, position]
          );
        } catch (error) {
          // Repair a pathological duplicate max-position case, then append.
          await renormalizeExistingColumn(columnId);
          const repairedPosition = await db.query(
            'SELECT COALESCE(MAX(position), 0) + $1 AS position FROM cards WHERE column_id = $2',
            [POSITION_STEP, columnId]
          );
          await db.query(
            'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
            [id, columnId, text, Number(repairedPosition.rows[0].position)]
          );
        }
        const card = await getCard(id);
        return { card, board: await readBoard() };
      })
    );

    broadcastMutation('create', { card: result.card, columnId: result.card.columnId, board: result.board });
    res.status(201).json({ card: result.card });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const id = normalizeId(req.params.id);
    const columnId = normalizeId(req.body?.columnId);
    const beforeId = normalizeId(req.body?.beforeId);
    const afterId = normalizeId(req.body?.afterId);
    if (!id) throw httpError(400, 'card id is required');
    if (!columnId) throw httpError(400, 'columnId is required');

    const result = await serializeMutation(() =>
      withTransaction(async () => {
        await ensureColumnExists(columnId);
        const existing = await getCard(id);
        if (!existing) throw httpError(404, `Card '${id}' was not found`);

        const targetCardsResult = await db.query(
          `SELECT id, position
           FROM cards
           WHERE column_id = $1 AND id <> $2
           ORDER BY position ASC, created_at ASC, id ASC`,
          [columnId, id]
        );
        const targetCards = targetCardsResult.rows;
        const insertion = calculateInsertion(targetCards, id, beforeId, afterId);
        let renormalized = insertion.shouldRenormalize;

        if (renormalized) {
          await renormalizeColumnWithMovedCard({
            columnId,
            movingCardId: id,
            orderedCards: targetCards,
            insertIndex: insertion.index,
          });
        } else {
          await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
            columnId,
            insertion.position,
            id,
          ]);
        }

        // A defensive collision check. It should normally be unnecessary after
        // fractional insertion, but it catches precision/pathological cases and
        // repairs the whole affected column before anyone observes the commit.
        const collisionResult = await db.query(
          `SELECT position, COUNT(*)::int AS count
           FROM cards
           WHERE column_id = $1
           GROUP BY position
           HAVING COUNT(*) > 1
           LIMIT 1`,
          [columnId]
        );
        if (collisionResult.rows.length > 0) {
          const allCardsResult = await db.query(
            `SELECT id, position
             FROM cards
             WHERE column_id = $1 AND id <> $2
             ORDER BY position ASC, created_at ASC, id ASC`,
            [columnId, id]
          );
          const cardIds = allCardsResult.rows.map((card) => card.id);
          let insertIndex = cardIds.findIndex((cardId) => cardId === beforeId);
          if (insertIndex === -1) {
            const afterIndex = cardIds.findIndex((cardId) => cardId === afterId);
            insertIndex = afterIndex === -1 ? allCardsResult.rows.length : afterIndex + 1;
          }
          await renormalizeColumnWithMovedCard({
            columnId,
            movingCardId: id,
            orderedCards: allCardsResult.rows,
            insertIndex,
          });
          renormalized = true;
        }

        const card = await getCard(id);
        return {
          card,
          previousColumnId: existing.columnId,
          renormalized,
          board: await readBoard(),
        };
      })
    );

    broadcastMutation('move', {
      card: result.card,
      columnId: result.card.columnId,
      previousColumnId: result.previousColumnId,
      renormalized: result.renormalized,
      board: result.board,
    });
    res.json({ card: result.card, renormalized: result.renormalized });
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
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });

  try {
    const board = await getBoard();
    if (sseClients.has(res)) {
      res.write(`event: board\ndata: ${JSON.stringify({ type: 'board', board })}\n\n`);
    }
  } catch {
    // If the initial state cannot be sent, the normal error path cannot be used
    // for an already-open SSE response. The client can reconnect.
  }
});

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': heartbeat\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 25_000).unref();

const distDir = path.join(ROOT_DIR, 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) res.status(404).send('Frontend build not found. Run npm run build or use npm run dev.');
  });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DB_DIR}`);
});
