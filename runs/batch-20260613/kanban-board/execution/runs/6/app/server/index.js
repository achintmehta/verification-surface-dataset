import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data', 'pglite');
const PORT = process.env.PORT || 3000;
const POSITION_STEP = 1000;
const EPSILON = 1e-9;

await mkdir(dataDir, { recursive: true });
const db = new PGlite(dataDir);

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of clients) {
    try {
      sendSse(res, event, payload);
    } catch {
      clients.delete(res);
    }
  }
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at);');

  const existing = await query('SELECT COUNT(*)::int AS count FROM columns;');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000],
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
    columnId: row.column_id ?? row.columnId,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at ?? row.createdAt,
  };
}

async function getBoard(client = db) {
  const columnsResult = await client.query('SELECT id, title, position FROM columns ORDER BY position ASC;');
  const cardsResult = await client.query(`
    SELECT id, column_id, text, position, created_at
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;
  `);

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: [],
  }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const row of cardsResult.rows) {
    const column = byId.get(row.column_id);
    if (column) column.cards.push(normalizeCard(row));
  }
  return { columns };
}

async function getCard(cardId, client = db) {
  const result = await client.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
    [cardId],
  );
  return normalizeCard(result.rows[0]);
}

async function renormalizeColumn(columnId, client = db) {
  const result = await client.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId],
  );
  let position = POSITION_STEP;
  for (const row of result.rows) {
    await client.query('UPDATE cards SET position = $1 WHERE id = $2;', [position, row.id]);
    position += POSITION_STEP;
  }
  return getColumnPayload(columnId, client);
}

async function getColumnPayload(columnId, client = db) {
  const columnResult = await client.query('SELECT id, title, position FROM columns WHERE id = $1;', [columnId]);
  if (columnResult.rows.length === 0) return null;
  const cardsResult = await client.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId],
  );
  const column = columnResult.rows[0];
  return {
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: cardsResult.rows.map(normalizeCard),
  };
}

async function computePosition(columnId, beforeId, afterId, movingCardId, client = db) {
  let before = null;
  let after = null;

  if (beforeId) {
    const result = await client.query(
      'SELECT id, position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3;',
      [beforeId, columnId, movingCardId ?? ''],
    );
    if (result.rows.length === 0) throw Object.assign(new Error('beforeId is not in the target column'), { status: 400 });
    before = Number(result.rows[0].position);
  }

  if (afterId) {
    const result = await client.query(
      'SELECT id, position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3;',
      [afterId, columnId, movingCardId ?? ''],
    );
    if (result.rows.length === 0) throw Object.assign(new Error('afterId is not in the target column'), { status: 400 });
    after = Number(result.rows[0].position);
  }

  if (before != null && after != null && after >= before) {
    throw Object.assign(new Error('afterId must be ordered before beforeId'), { status: 400 });
  }

  if (before == null && after == null) {
    const maxResult = await client.query(
      'SELECT MAX(position) AS max FROM cards WHERE column_id = $1 AND id <> $2;',
      [columnId, movingCardId ?? ''],
    );
    const max = maxResult.rows[0].max == null ? 0 : Number(maxResult.rows[0].max);
    return max + POSITION_STEP;
  }
  if (before == null) return after + POSITION_STEP;
  if (after == null) return before / 2;
  return (before + after) / 2;
}

async function transaction(fn) {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn);
  }
  await query('BEGIN;');
  try {
    const value = await fn(db);
    await query('COMMIT;');
    return value;
  } catch (error) {
    await query('ROLLBACK;');
    throw error;
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'connected', { ok: true, connectedClients: clients.size });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const columnId = String(req.body.columnId ?? '');
    const text = String(req.body.text ?? '').trim();
    if (!columnId || !text) return res.status(400).json({ error: 'columnId and text are required' });

    let payload;
    await transaction(async (tx) => {
      const column = await tx.query('SELECT id FROM columns WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });

      const id = randomUUID();
      const position = await computePosition(columnId, null, null, null, tx);
      await tx.query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);', [
        id,
        columnId,
        text,
        position,
      ]);
      const card = await getCard(id, tx);
      payload = { card, columnId, board: await getBoard(tx) };
    });

    broadcast('card:create', payload);
    broadcast('board', payload.board);
    res.status(201).json(payload);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const columnId = String(req.body.columnId ?? '');
    const beforeId = req.body.beforeId == null ? null : String(req.body.beforeId);
    const afterId = req.body.afterId == null ? null : String(req.body.afterId);
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && afterId && beforeId === afterId) return res.status(400).json({ error: 'beforeId and afterId must differ' });

    let payload;
    await transaction(async (tx) => {
      const column = await tx.query('SELECT id FROM columns WHERE id = $1;', [columnId]);
      if (column.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });
      const existing = await tx.query('SELECT id, column_id FROM cards WHERE id = $1;', [cardId]);
      if (existing.rows.length === 0) throw Object.assign(new Error('Card not found'), { status: 404 });
      const oldColumnId = existing.rows[0].column_id;

      const position = await computePosition(columnId, beforeId, afterId, cardId, tx);
      await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, cardId]);

      const updated = await getCard(cardId, tx);
      const collisionResult = await tx.query(
        'SELECT COUNT(*)::int AS count FROM cards WHERE column_id = $1 AND position = $2;',
        [columnId, updated.position],
      );
      let renormalizedColumns = [];
      if (Number(collisionResult.rows[0].count) > 1 || !Number.isFinite(updated.position) || Math.abs(updated.position) < EPSILON) {
        const normalized = await renormalizeColumn(columnId, tx);
        if (normalized) renormalizedColumns.push(normalized);
      }
      if (oldColumnId !== columnId) {
        const source = await getColumnPayload(oldColumnId, tx);
        if (source) renormalizedColumns.push(source);
      }

      payload = {
        card: await getCard(cardId, tx),
        columnId,
        previousColumnId: oldColumnId,
        renormalizedColumns,
        board: await getBoard(tx),
      };
    });

    broadcast('card:move', payload);
    broadcast('board', payload.board);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
});
