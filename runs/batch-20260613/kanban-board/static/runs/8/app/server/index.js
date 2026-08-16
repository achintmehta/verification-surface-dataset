import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), 'data', 'pglite');
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-7;

const app = express();
const db = new PGlite(DATA_DIR);
const sseClients = new Set();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
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

  await db.query('CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position)');

  const existing = await db.query('SELECT COUNT(*) AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];

    for (const [id, title, position] of defaults) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [id, title, position]
      );
    }
  }
}

function normalizeCard(row) {
  if (!row) return row;
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at
  };
}

async function getBoard(client = db) {
  const [columnResult, cardResult] = await Promise.all([
    client.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    client.query(`
      SELECT id, column_id, text, position, created_at
      FROM cards
      ORDER BY column_id ASC, position ASC, created_at ASC, id ASC
    `)
  ]);

  const cardsByColumn = new Map();
  for (const card of cardResult.rows) {
    if (!cardsByColumn.has(card.column_id)) cardsByColumn.set(card.column_id, []);
    cardsByColumn.get(card.column_id).push(normalizeCard(card));
  }

  return {
    columns: columnResult.rows.map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: cardsByColumn.get(column.id) || []
    }))
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const client of sseClients) {
    sendSse(client, event, payload);
  }
}

async function broadcastBoard(kind, payload = {}) {
  const board = await getBoard();
  broadcast('board', {
    kind,
    ...payload,
    board
  });
}

function stripNullableId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function columnExists(client, columnId) {
  const result = await client.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
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
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);
  sendSse(res, 'connected', { ok: true });

  try {
    sendSse(res, 'board', { kind: 'sync', board: await getBoard() });
  } catch (error) {
    sendSse(res, 'error', { message: error.message });
  }

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const columnId = typeof req.body?.columnId === 'string' ? req.body.columnId : null;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!columnId) throw httpError(400, 'columnId is required');
    if (!text) throw httpError(400, 'Card text is required');

    const card = await db.transaction(async (tx) => {
      if (!(await columnExists(tx, columnId))) throw httpError(404, 'Column not found');

      const maxResult = await tx.query(
        'SELECT COALESCE(MAX(position), 0) + $1 AS next_position FROM cards WHERE column_id = $2',
        [POSITION_STEP, columnId]
      );
      const position = Number(maxResult.rows[0].next_position);
      const id = randomUUID();

      const inserted = await tx.query(
        `INSERT INTO cards (id, column_id, text, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id, column_id, text, position, created_at`,
        [id, columnId, text, position]
      );

      return normalizeCard(inserted.rows[0]);
    });

    await broadcastBoard('card-created', { card, columnId: card.columnId });
    res.status(201).json({ card });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const columnId = typeof req.body?.columnId === 'string' ? req.body.columnId : null;
    const beforeId = stripNullableId(req.body?.beforeId);
    const afterId = stripNullableId(req.body?.afterId);

    if (!columnId) throw httpError(400, 'columnId is required');
    if (beforeId === cardId || afterId === cardId) {
      throw httpError(400, 'A card cannot be placed relative to itself');
    }
    if (beforeId && afterId && beforeId === afterId) {
      throw httpError(400, 'beforeId and afterId must refer to different cards');
    }

    const result = await db.transaction(async (tx) => {
      const existingCard = await tx.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      if (existingCard.rows.length === 0) throw httpError(404, 'Card not found');
      if (!(await columnExists(tx, columnId))) throw httpError(404, 'Column not found');

      const ordered = await tx.query(
        `SELECT id, position
         FROM cards
         WHERE column_id = $1 AND id <> $2
         ORDER BY position ASC, created_at ASC, id ASC`,
        [columnId, cardId]
      );
      const rows = ordered.rows.map((row) => ({ id: row.id, position: Number(row.position) }));
      const indexes = new Map(rows.map((row, index) => [row.id, index]));

      if (beforeId && !indexes.has(beforeId)) throw httpError(400, 'beforeId is not in the target column');
      if (afterId && !indexes.has(afterId)) throw httpError(400, 'afterId is not in the target column');

      let insertIndex = rows.length;
      if (afterId) {
        insertIndex = indexes.get(afterId) + 1;
      } else if (beforeId) {
        insertIndex = indexes.get(beforeId);
      }

      const previous = insertIndex > 0 ? rows[insertIndex - 1] : null;
      const nextCard = insertIndex < rows.length ? rows[insertIndex] : null;

      let position;
      let renormalized = false;

      if (previous && nextCard) {
        const gap = nextCard.position - previous.position;
        position = previous.position + gap / 2;
        if (!Number.isFinite(position) || gap <= MIN_POSITION_GAP || position <= previous.position || position >= nextCard.position) {
          renormalized = true;
        }
      } else if (previous) {
        position = previous.position + POSITION_STEP;
        if (!Number.isFinite(position) || position <= previous.position) renormalized = true;
      } else if (nextCard) {
        position = nextCard.position - POSITION_STEP;
        if (!Number.isFinite(position) || position >= nextCard.position) renormalized = true;
      } else {
        position = POSITION_STEP;
      }

      if (renormalized) {
        const desiredOrder = rows.map((row) => row.id);
        desiredOrder.splice(insertIndex, 0, cardId);

        for (const [index, id] of desiredOrder.entries()) {
          await tx.query(
            'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
            [columnId, (index + 1) * POSITION_STEP, id]
          );
        }
      } else {
        await tx.query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
          [columnId, position, cardId]
        );
      }

      const updated = await tx.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );

      return { card: normalizeCard(updated.rows[0]), renormalized };
    });

    await broadcastBoard('card-moved', {
      card: result.card,
      columnId: result.card.columnId,
      renormalized: result.renormalized
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
