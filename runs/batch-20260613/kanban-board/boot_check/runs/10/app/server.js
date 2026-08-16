import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '.pglite-data');
const POSITION_STEP = 1024;
const EPSILON = 1e-9;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DATA_DIR);
const clients = new Set();

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of clients) {
    try {
      sseWrite(res, event, payload);
    } catch {
      clients.delete(res);
    }
  }
}

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM "columns"');
  if (Number(existing.rows[0].count) === 0) {
    await db.query(
      'INSERT INTO "columns" (id, title, position) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
      ['todo', 'To Do', 1024, 'in-progress', 'In Progress', 2048, 'done', 'Done', 3072]
    );
  }
}

function mapCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM "columns" ORDER BY position, id');
  const cardsResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position, created_at, id');
  const cardsByColumn = new Map();

  for (const row of cardsResult.rows) {
    const card = mapCard(row);
    if (!cardsByColumn.has(card.columnId)) cardsByColumn.set(card.columnId, []);
    cardsByColumn.get(card.columnId).push(card);
  }

  return {
    columns: columnsResult.rows.map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: cardsByColumn.get(column.id) || [],
    })),
  };
}

async function requireColumn(columnId) {
  const result = await db.query('SELECT id FROM "columns" WHERE id = $1', [columnId]);
  if (result.rows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }
}

async function getNeighborPosition(cardId, columnId, label) {
  if (!cardId) return null;
  const result = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [cardId, columnId]);
  if (result.rows.length === 0) {
    const err = new Error(`${label} card not found in target column`);
    err.status = 400;
    throw err;
  }
  return Number(result.rows[0].position);
}

async function positionAtEnd(columnId) {
  const result = await db.query('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1', [columnId]);
  const max = result.rows[0].max_position;
  return max == null ? POSITION_STEP : Number(max) + POSITION_STEP;
}

async function computePosition(columnId, beforeId, afterId) {
  const afterPosition = await getNeighborPosition(afterId, columnId, 'afterId');
  const beforePosition = await getNeighborPosition(beforeId, columnId, 'beforeId');

  if (afterPosition != null && beforePosition != null) {
    if (!(afterPosition < beforePosition)) {
      const err = new Error('afterId must be ordered before beforeId');
      err.status = 400;
      throw err;
    }
    return (afterPosition + beforePosition) / 2;
  }

  if (afterPosition != null) return afterPosition + POSITION_STEP;
  if (beforePosition != null) return beforePosition / 2;
  return positionAtEnd(columnId);
}

async function maybeRenormalizeColumn(columnId, focusCardId = null) {
  const rows = (await db.query('SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position, created_at, id', [columnId])).rows;
  let shouldRenormalize = false;
  let previous = null;
  for (const row of rows) {
    const position = Number(row.position);
    if (previous != null && position - previous <= EPSILON) {
      shouldRenormalize = true;
      break;
    }
    previous = position;
  }

  if (!shouldRenormalize) return null;

  let focused = null;
  for (let i = 0; i < rows.length; i += 1) {
    const newPosition = (i + 1) * POSITION_STEP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPosition, rows[i].id]);
    if (rows[i].id === focusCardId) focused = { ...rows[i], position: newPosition };
  }

  return {
    columnId,
    card: focused,
    order: rows.map((row, i) => ({ id: row.id, position: (i + 1) * POSITION_STEP })),
  };
}

async function canonicalCard(cardId) {
  const result = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
  return result.rows[0] ? mapCard(result.rows[0]) : null;
}

async function mutateInTransaction(work) {
  await db.exec('BEGIN');
  try {
    const result = await work();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    const cleanText = String(text || '').trim();
    if (!columnId || !cleanText) return res.status(400).json({ error: 'columnId and text are required' });

    const id = randomUUID();
    const card = await mutateInTransaction(async () => {
      await requireColumn(columnId);
      const position = await positionAtEnd(columnId);
      await db.query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)', [id, columnId, cleanText, position]);
      await maybeRenormalizeColumn(columnId, id);
      return canonicalCard(id);
    });

    res.status(201).json({ card });
    broadcast('create', { card });
    broadcast('board', await getBoard());
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === id) return res.status(400).json({ error: 'beforeId cannot be the moved card' });
    if (afterId && afterId === id) return res.status(400).json({ error: 'afterId cannot be the moved card' });

    const result = await mutateInTransaction(async () => {
      await requireColumn(columnId);
      const exists = await db.query('SELECT id, column_id AS old_column_id FROM cards WHERE id = $1', [id]);
      if (exists.rows.length === 0) {
        const err = new Error('Card not found');
        err.status = 404;
        throw err;
      }

      const oldColumnId = exists.rows[0].old_column_id;
      const position = await computePosition(columnId, beforeId, afterId);
      await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, id]);
      const targetRenormalization = await maybeRenormalizeColumn(columnId, id);
      if (oldColumnId !== columnId) await maybeRenormalizeColumn(oldColumnId);
      return { card: await canonicalCard(id), oldColumnId, renormalized: targetRenormalization };
    });

    res.json({ card: result.card });
    broadcast('move', { card: result.card, oldColumnId: result.oldColumnId, renormalized: result.renormalized });
    broadcast('board', await getBoard());
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
  sseWrite(res, 'connected', { now: new Date().toISOString() });
  try {
    sseWrite(res, 'board', await getBoard());
  } catch (error) {
    sseWrite(res, 'error', { error: error.message });
  }

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); clients.delete(res); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
app.use('/src', express.static(path.join(__dirname, 'src')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
