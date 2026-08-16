import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3001);
const DATABASE_DIR = process.env.DATABASE_DIR || path.join(rootDir, '.pglite-data');
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-7;

const app = express();
const db = new PGlite(DATABASE_DIR);
const clients = new Set();
let mutationQueue = Promise.resolve();

app.use(cors());
app.use(express.json());

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id);
  `);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    await db.query(
      `INSERT INTO columns (id, title, position) VALUES
       ($1, 'To Do', 1000),
       ($2, 'In Progress', 2000),
       ($3, 'Done', 3000)`,
      ['todo', 'in-progress', 'done']
    );
  }
}

function serializeMutation(fn) {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.catch(() => {});
  return next;
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC');

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: []
  }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (!column) continue;
    column.cards.push({
      id: card.id,
      columnId: card.column_id,
      text: card.text,
      position: Number(card.position),
      createdAt: card.created_at
    });
  }

  return { columns };
}

function writeSse(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(eventName, payload) {
  for (const client of clients) {
    try {
      writeSse(client, eventName, payload);
    } catch {
      clients.delete(client);
    }
  }
}

async function renormalizeColumn(columnId, tx = db) {
  const result = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );

  for (let i = 0; i < result.rows.length; i += 1) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (i + 1) * POSITION_STEP,
      result.rows[i].id
    ]);
  }
}

function positionBetween(afterPosition, beforePosition) {
  if (afterPosition == null && beforePosition == null) return POSITION_STEP;
  if (afterPosition == null) return beforePosition - POSITION_STEP;
  if (beforePosition == null) return afterPosition + POSITION_STEP;
  return (afterPosition + beforePosition) / 2;
}

function needsRenormalization(position, afterPosition, beforePosition) {
  if (!Number.isFinite(position)) return true;
  if (afterPosition != null && !(position > afterPosition)) return true;
  if (beforePosition != null && !(position < beforePosition)) return true;
  if (afterPosition != null && beforePosition != null) {
    if (position === afterPosition || position === beforePosition) return true;
    if (Math.abs(beforePosition - afterPosition) < MIN_POSITION_GAP) return true;
  }
  return false;
}

async function computeMovePosition(tx, { columnId, beforeId, afterId, movingCardId }) {
  const calculate = async () => {
    const ordered = await tx.query(
      `SELECT id, position
       FROM cards
       WHERE column_id = $1 AND id <> $2
       ORDER BY position ASC, created_at ASC, id ASC`,
      [columnId, movingCardId]
    );
    const cards = ordered.rows.map((row) => ({ id: row.id, position: Number(row.position) }));

    const afterIndex = afterId ? cards.findIndex((card) => card.id === afterId) : -1;
    const beforeIndex = beforeId ? cards.findIndex((card) => card.id === beforeId) : -1;

    let targetIndex;
    if (afterIndex !== -1 && beforeIndex !== -1) {
      // If concurrent edits made the originally adjacent neighbors non-adjacent, choose a
      // deterministic canonical slot between the two known boundaries where possible.
      targetIndex = afterIndex < beforeIndex ? afterIndex + 1 : beforeIndex;
    } else if (afterIndex !== -1) {
      targetIndex = afterIndex + 1;
    } else if (beforeIndex !== -1) {
      targetIndex = beforeIndex;
    } else {
      targetIndex = cards.length;
    }

    targetIndex = Math.max(0, Math.min(targetIndex, cards.length));
    const afterPosition = targetIndex > 0 ? cards[targetIndex - 1].position : null;
    const beforePosition = targetIndex < cards.length ? cards[targetIndex].position : null;
    const position = positionBetween(afterPosition, beforePosition);
    return { position, afterPosition, beforePosition };
  };

  let { position, afterPosition, beforePosition } = await calculate();
  let renormalized = false;

  if (needsRenormalization(position, afterPosition, beforePosition)) {
    await renormalizeColumn(columnId, tx);
    renormalized = true;
    ({ position, afterPosition, beforePosition } = await calculate());
  }

  return { position, renormalized };
}

async function withTransaction(fn) {
  await db.query('BEGIN');
  try {
    const value = await fn(db);
    await db.query('COMMIT');
    return value;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
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
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  writeSse(res, 'connected', { ok: true, now: new Date().toISOString() });

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const result = await serializeMutation(async () => {
      const text = String(req.body?.text || '').trim();
      const columnId = String(req.body?.columnId || '');
      if (!text) {
        const error = new Error('Card text is required');
        error.status = 400;
        throw error;
      }
      if (!columnId) {
        const error = new Error('columnId is required');
        error.status = 400;
        throw error;
      }

      const outcome = await withTransaction(async (tx) => {
        const column = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const max = await tx.query(
          'SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1',
          [columnId]
        );
        const id = randomUUID();
        const position = Number(max.rows[0].max_position) + POSITION_STEP;
        const inserted = await tx.query(
          `INSERT INTO cards (id, column_id, text, position)
           VALUES ($1, $2, $3, $4)
           RETURNING id, column_id, text, position, created_at`,
          [id, columnId, text, position]
        );
        return inserted.rows[0];
      });

      const card = {
        id: outcome.id,
        columnId: outcome.column_id,
        text: outcome.text,
        position: Number(outcome.position),
        createdAt: outcome.created_at
      };
      const board = await getBoard();
      broadcast('card:create', { type: 'card:create', card, columnId: card.columnId, board });
      return { card, board };
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const result = await serializeMutation(async () => {
      const cardId = req.params.id;
      const columnId = String(req.body?.columnId || '');
      const beforeId = req.body?.beforeId ? String(req.body.beforeId) : null;
      const afterId = req.body?.afterId ? String(req.body.afterId) : null;

      if (!columnId) {
        const error = new Error('columnId is required');
        error.status = 400;
        throw error;
      }
      if (beforeId && beforeId === cardId) {
        const error = new Error('beforeId cannot be the moving card');
        error.status = 400;
        throw error;
      }
      if (afterId && afterId === cardId) {
        const error = new Error('afterId cannot be the moving card');
        error.status = 400;
        throw error;
      }

      const outcome = await withTransaction(async (tx) => {
        const cardCheck = await tx.query('SELECT id FROM cards WHERE id = $1', [cardId]);
        const columnCheck = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (cardCheck.rows.length === 0) {
          const error = new Error('Card not found');
          error.status = 404;
          throw error;
        }
        if (columnCheck.rows.length === 0) {
          const error = new Error('Column not found');
          error.status = 404;
          throw error;
        }

        const { position, renormalized } = await computeMovePosition(tx, {
          columnId,
          beforeId,
          afterId,
          movingCardId: cardId
        });
        const updated = await tx.query(
          `UPDATE cards
           SET column_id = $1, position = $2
           WHERE id = $3
           RETURNING id, column_id, text, position, created_at`,
          [columnId, position, cardId]
        );
        return { row: updated.rows[0], renormalized };
      });

      const card = {
        id: outcome.row.id,
        columnId: outcome.row.column_id,
        text: outcome.row.text,
        position: Number(outcome.row.position),
        createdAt: outcome.row.created_at
      };
      const board = await getBoard();
      broadcast('card:move', {
        type: 'card:move',
        card,
        columnId: card.columnId,
        board,
        renormalized: outcome.renormalized
      });
      return { card, board, renormalized: outcome.renormalized };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'), (err) => {
    if (err) {
      if (res.headersSent) return next(err);
      return res.status(404).json({ error: 'Client build not found. Run npm run build or use npm run dev.' });
    }
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
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_DIR}`);
});
