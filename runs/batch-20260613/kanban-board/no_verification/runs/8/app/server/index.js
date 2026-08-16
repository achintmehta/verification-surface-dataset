import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3001;
const DATABASE_PATH = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'data', 'pglite');
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-7;

const app = express();
const db = new PGlite(DATABASE_PATH);
const clients = new Set();
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const distDir = path.join(rootDir, 'web', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}


function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function tx(work) {
  await db.query('BEGIN');
  try {
    const result = await work();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function rows(result) {
  return result?.rows ?? [];
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);');

  const existing = rows(await db.query('SELECT COUNT(*)::int AS count FROM columns'))[0]?.count ?? 0;
  if (Number(existing) === 0) {
    const defaults = [
      { id: 'todo', title: 'To Do', position: 1000 },
      { id: 'in-progress', title: 'In Progress', position: 2000 },
      { id: 'done', title: 'Done', position: 3000 }
    ];
    for (const column of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [
        column.id,
        column.title,
        column.position
      ]);
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
    createdAt: row.created_at
  };
}

async function getBoard() {
  const columnRows = rows(
    await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC')
  );
  const cardRows = rows(
    await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
    )
  );

  const columns = columnRows.map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: []
  }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const card of cardRows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push(normalizeCard(card));
  }

  return { columns };
}

async function getCard(id) {
  return normalizeCard(rows(await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [id]
  ))[0]);
}

async function assertColumnExists(columnId) {
  const exists = rows(await db.query('SELECT 1 FROM columns WHERE id = $1', [columnId]))[0];
  if (!exists) {
    const error = new Error(`Unknown column: ${columnId}`);
    error.status = 404;
    throw error;
  }
}

async function renormalizeColumn(columnId) {
  const ordered = rows(await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  ));

  for (let index = 0; index < ordered.length; index += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, ordered[index].id]);
  }
}

async function computePosition(columnId, movingCardId, beforeId, afterId) {
  let before = null;
  let after = null;

  if (beforeId) {
    before = rows(await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]))[0];
    if (!before || before.id === movingCardId) before = null;
  }

  if (afterId) {
    after = rows(await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]))[0];
    if (!after || after.id === movingCardId) after = null;
  }

  if (!before && !after) {
    const maxPosition = rows(await db.query(
      'SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1 AND id <> $2',
      [columnId, movingCardId]
    ))[0]?.max_position;
    return maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
  }

  if (before && after) {
    const beforePosition = Number(before.position);
    const afterPosition = Number(after.position);
    if (beforePosition <= afterPosition || beforePosition - afterPosition <= MIN_POSITION_GAP) {
      return null;
    }
    return (beforePosition + afterPosition) / 2;
  }

  if (before) {
    const firstPosition = Number(before.position);
    if (firstPosition > MIN_POSITION_GAP) return firstPosition / 2;
    return null;
  }

  return Number(after.position) + POSITION_STEP;
}

async function moveCardCanonical(cardId, columnId, beforeId, afterId) {
  return tx(async () => {
    await assertColumnExists(columnId);

    const existing = await getCard(cardId);
    if (!existing) {
      const error = new Error(`Unknown card: ${cardId}`);
      error.status = 404;
      throw error;
    }

    const affectedColumns = new Set([existing.columnId, columnId]);
    let newPosition = await computePosition(columnId, cardId, beforeId, afterId);
    if (newPosition == null || !Number.isFinite(newPosition)) {
      await renormalizeColumn(columnId);
      newPosition = await computePosition(columnId, cardId, beforeId, afterId);
    }

    if (newPosition == null || !Number.isFinite(newPosition)) {
      const maxPosition = rows(await db.query(
        'SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1 AND id <> $2',
        [columnId, cardId]
      ))[0]?.max_position;
      newPosition = maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
    }

    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, newPosition, cardId]);

    for (const affectedColumnId of affectedColumns) {
      const collisionCount = Number(rows(await db.query(
        'SELECT COUNT(*)::int AS count FROM cards WHERE column_id = $1 GROUP BY position HAVING COUNT(*) > 1 LIMIT 1',
        [affectedColumnId]
      ))[0]?.count ?? 0);
      if (collisionCount > 0) await renormalizeColumn(affectedColumnId);
    }

    return getCard(cardId);
  });
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function broadcast(type, payload = {}) {
  const board = await getBoard();
  const message = { type, ...payload, board };
  for (const client of clients) {
    sendEvent(client, type, message);
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
    const { columnId, text } = req.body ?? {};
    const trimmed = String(text ?? '').trim();
    if (!columnId || !trimmed) return res.status(400).json({ error: 'columnId and text are required' });

    const card = await enqueueMutation(async () => tx(async () => {
      await assertColumnExists(columnId);
      const maxPosition = rows(await db.query(
        'SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1',
        [columnId]
      ))[0]?.max_position;
      const position = maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
      const id = randomUUID();
      const inserted = rows(await db.query(
        `INSERT INTO cards (id, column_id, text, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id, column_id, text, position, created_at`,
        [id, columnId, trimmed, position]
      ))[0];
      return normalizeCard(inserted);
    }));

    await broadcast('card:create', { card, columnId: card.columnId });
    res.status(201).json({ card });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && afterId && beforeId === afterId) {
      return res.status(400).json({ error: 'beforeId and afterId must be different' });
    }

    const card = await enqueueMutation(() => moveCardCanonical(req.params.id, columnId, beforeId, afterId));
    await broadcast('card:move', { card, columnId: card.columnId });
    res.json({ card });
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
  sendEvent(res, 'connected', { type: 'connected', board: await getBoard() });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

if (existsSync(distDir)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_PATH}`);
});
