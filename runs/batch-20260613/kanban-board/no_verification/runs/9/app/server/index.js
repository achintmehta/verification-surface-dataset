import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(projectRoot, 'data', 'pglite');
const POSITION_STEP = 1000;
const COLLISION_EPSILON = 1e-7;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);
const app = express();
const clients = new Map();
let transactionChain = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function rowList(result) {
  return result?.rows || [];
}

async function q(sql, params = []) {
  return db.query(sql, params);
}

async function runInTransaction(work) {
  // PGLite is embedded in this Node process; queue mutations so BEGIN/COMMIT
  // blocks cannot interleave when multiple HTTP requests arrive concurrently.
  const previous = transactionChain;
  let release;
  transactionChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});

  try {
    await q('BEGIN');
    try {
      const value = await work();
      await q('COMMIT');
      return value;
    } catch (error) {
      try {
        await q('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
      throw error;
    }
  } finally {
    release();
  }
}

async function initDatabase() {
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await q('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);');

  const existing = rowList(await q('SELECT COUNT(*)::int AS count FROM columns;'))[0]?.count || 0;
  if (existing === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000],
    ];
    for (const [id, title, position] of defaults) {
      await q('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3);', [id, title, position]);
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
    createdAt: row.created_at,
  };
}

async function getBoardState() {
  const columns = rowList(await q('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;')).map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: [],
  }));

  const byId = new Map(columns.map((column) => [column.id, column]));
  const cards = rowList(await q(`
    SELECT id, column_id, text, position, created_at
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;
  `));

  for (const row of cards) {
    const column = byId.get(row.column_id);
    if (column) column.cards.push(normalizeCard(row));
  }

  return { columns };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const [id, res] of clients) {
    try {
      sendSse(res, event, payload);
    } catch (error) {
      clients.delete(id);
    }
  }
}

async function broadcastMutation(action, card, extra = {}) {
  const board = await getBoardState();
  broadcast('mutation', {
    action,
    card,
    columnId: card?.columnId,
    board,
    ...extra,
  });
}

async function assertColumnExists(columnId) {
  const row = rowList(await q('SELECT id FROM columns WHERE id = $1;', [columnId]))[0];
  if (!row) {
    const err = new Error(`Column '${columnId}' does not exist`);
    err.status = 404;
    throw err;
  }
}

async function renormalizeColumn(columnId) {
  const cards = rowList(await q(`
    SELECT id
    FROM cards
    WHERE column_id = $1
    ORDER BY position ASC, created_at ASC, id ASC;
  `, [columnId]));

  const corrected = [];
  for (let index = 0; index < cards.length; index += 1) {
    const position = (index + 1) * POSITION_STEP;
    await q('UPDATE cards SET position = $1 WHERE id = $2;', [position, cards[index].id]);
    corrected.push({ id: cards[index].id, position });
  }
  return corrected;
}

async function getNeighborPosition(id, columnId, movingCardId) {
  if (!id) return null;
  if (id === movingCardId) return null;
  const row = rowList(await q(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2;',
    [id, columnId],
  ))[0];
  if (!row) {
    const err = new Error(`Neighbor card '${id}' is not in target column '${columnId}'`);
    err.status = 400;
    throw err;
  }
  return Number(row.position);
}

async function computePosition(columnId, beforeId, afterId, movingCardId, renormalizedColumns = null) {
  let beforePos = await getNeighborPosition(beforeId, columnId, movingCardId);
  let afterPos = await getNeighborPosition(afterId, columnId, movingCardId);

  if (beforePos == null && afterPos == null) {
    const maxRow = rowList(await q(
      'SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1 AND id <> $2;',
      [columnId, movingCardId || ''],
    ))[0];
    const maxPosition = maxRow?.max_position == null ? 0 : Number(maxRow.max_position);
    return maxPosition + POSITION_STEP;
  }

  if (beforePos == null) {
    return afterPos + POSITION_STEP;
  }

  if (afterPos == null) {
    return beforePos - POSITION_STEP;
  }

  if (afterPos >= beforePos) {
    // The client may have sent neighbor ids based on a now-stale order. Renormalize
    // first; if the intent is still contradictory, prefer the "after" anchor and let
    // the authoritative broadcast converge every client on the resulting order.
    await renormalizeColumn(columnId);
    renormalizedColumns?.add(columnId);
    beforePos = await getNeighborPosition(beforeId, columnId, movingCardId);
    afterPos = await getNeighborPosition(afterId, columnId, movingCardId);
    if (afterPos >= beforePos) return afterPos + POSITION_STEP;
  }

  const midpoint = (afterPos + beforePos) / 2;
  if (!Number.isFinite(midpoint) || midpoint === beforePos || midpoint === afterPos || Math.abs(beforePos - afterPos) < COLLISION_EPSILON) {
    await renormalizeColumn(columnId);
    renormalizedColumns?.add(columnId);
    beforePos = await getNeighborPosition(beforeId, columnId, movingCardId);
    afterPos = await getNeighborPosition(afterId, columnId, movingCardId);
    return (afterPos + beforePos) / 2;
  }

  return midpoint;
}

async function hasPositionCollision(columnId, cardId, position) {
  const row = rowList(await q(`
    SELECT id
    FROM cards
    WHERE column_id = $1
      AND id <> $2
      AND ABS(position - $3) < $4
    LIMIT 1;
  `, [columnId, cardId, position, COLLISION_EPSILON]))[0];
  return Boolean(row);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoardState());
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const columnId = String(req.body?.columnId || '');
    const text = String(req.body?.text || '').trim();

    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });

    const card = await runInTransaction(async () => {
      await assertColumnExists(columnId);
      const position = await computePosition(columnId, null, null, null);
      const id = randomUUID();
      const inserted = rowList(await q(`
        INSERT INTO cards (id, column_id, text, position)
        VALUES ($1, $2, $3, $4)
        RETURNING id, column_id, text, position, created_at;
      `, [id, columnId, text, position]))[0];
      return normalizeCard(inserted);
    });

    res.status(201).json({ card });
    await broadcastMutation('create', card);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const id = req.params.id;
    const columnId = String(req.body?.columnId || '');
    const beforeId = req.body?.beforeId || null;
    const afterId = req.body?.afterId || null;

    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === afterId) return res.status(400).json({ error: 'beforeId and afterId must differ' });
    if (beforeId === id || afterId === id) return res.status(400).json({ error: 'A card cannot be positioned relative to itself' });

    let renormalizedColumns = new Set();
    const card = await runInTransaction(async () => {
      await assertColumnExists(columnId);
      const current = rowList(await q('SELECT id, column_id FROM cards WHERE id = $1;', [id]))[0];
      if (!current) {
        const err = new Error(`Card '${id}' does not exist`);
        err.status = 404;
        throw err;
      }

      const position = await computePosition(columnId, beforeId, afterId, id, renormalizedColumns);
      const updated = rowList(await q(`
        UPDATE cards
        SET column_id = $1, position = $2
        WHERE id = $3
        RETURNING id, column_id, text, position, created_at;
      `, [columnId, position, id]))[0];

      if (await hasPositionCollision(columnId, id, position)) {
        await renormalizeColumn(columnId);
        renormalizedColumns.add(columnId);
      }

      if (current.column_id !== columnId) {
        // Safe but not required for correctness: compact the source column after
        // cross-column moves during the same transaction, then broadcast the full
        // canonical board once committed.
        await renormalizeColumn(current.column_id);
        renormalizedColumns.add(current.column_id);
      }

      const canonical = rowList(await q(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
        [id],
      ))[0];
      return normalizeCard(canonical || updated);
    });

    res.json({ card });
    await broadcastMutation('move', card, { renormalizedColumns: Array.from(renormalizedColumns) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const id = randomUUID();
    clients.set(id, res);

    sendSse(res, 'connected', { id });
    sendSse(res, 'board', { board: await getBoardState() });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(id);
    });
  } catch (error) {
    next(error);
  }
});

const clientDist = path.join(projectRoot, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(clientDist, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send('Frontend has not been built. Run npm run build, or use npm run client:dev during development.');
  }
  res.sendFile(indexPath, (error) => {
    if (error) next(error);
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
});

await initDatabase();

app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
