import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_DIR = process.env.DATABASE_DIR || path.join(ROOT, 'pgdata');
const POSITION_STEP = 1000;
const EPSILON = 1e-9;

const db = new PGlite(DATABASE_DIR);
const app = express();

app.use(cors());
app.use(express.json());

let writeQueue = Promise.resolve();
const clients = new Set();

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function asNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

function normalizeCard(row) {
  return {
    id: row.id,
    column_id: row.column_id,
    text: row.text,
    position: asNumber(row.position),
    created_at: row.created_at,
  };
}

function normalizeColumn(row) {
  return {
    id: row.id,
    title: row.title,
    position: asNumber(row.position),
    cards: [],
  };
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

  await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);`);

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      { id: 'todo', title: 'To Do', position: 1000 },
      { id: 'in-progress', title: 'In Progress', position: 2000 },
      { id: 'done', title: 'Done', position: 3000 },
    ];

    for (const column of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [
        column.id,
        column.title,
        column.position,
      ]);
    }
  }
}

async function getBoardState() {
  const [columnResult, cardResult] = await Promise.all([
    db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'),
  ]);

  const columns = columnResult.rows.map(normalizeColumn);
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const row of cardResult.rows) {
    const card = normalizeCard(row);
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }

  return { columns };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    sendSse(res, event, data);
  }
}

async function broadcastMutation(event, payload) {
  broadcast(event, payload);
  const board = await getBoardState();
  broadcast('board', board);
}

async function getCardById(id) {
  const result = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  return result.rows[0] ? normalizeCard(result.rows[0]) : null;
}

function pickPosition(sortedRows, insertIndex) {
  const lower = insertIndex > 0 ? asNumber(sortedRows[insertIndex - 1].position) : null;
  const upper = insertIndex < sortedRows.length ? asNumber(sortedRows[insertIndex].position) : null;

  let position;
  if (lower !== null && upper !== null) {
    position = (lower + upper) / 2;
  } else if (lower !== null) {
    position = lower + POSITION_STEP;
  } else if (upper !== null) {
    position = upper > 1 ? upper / 2 : upper - POSITION_STEP;
  } else {
    position = POSITION_STEP;
  }

  const exhausted =
    !Number.isFinite(position) ||
    (lower !== null && Math.abs(position - lower) <= EPSILON) ||
    (upper !== null && Math.abs(upper - position) <= EPSILON) ||
    (lower !== null && upper !== null && Math.abs(upper - lower) <= EPSILON);

  return { position, exhausted };
}

async function renormalizeColumn(columnId, orderedIds = null) {
  let ids = orderedIds;
  if (!ids) {
    const result = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
      [columnId],
    );
    ids = result.rows.map((row) => row.id);
  }

  for (let i = 0; i < ids.length; i += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, ids[i]]);
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
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

app.get('/api/stream', async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'connected', { time: new Date().toISOString() });
  sendSse(res, 'board', await getBoardState());

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  _req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    res.end();
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    const columnId = String(req.body?.columnId || req.body?.column_id || '').trim();

    if (!text) throw httpError(400, 'Card text is required.');
    if (!columnId) throw httpError(400, 'columnId is required.');

    const card = await enqueueWrite(async () => {
      await db.query('BEGIN');
      try {
        const column = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) throw httpError(404, 'Column not found.');

        const maxResult = await db.query('SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1', [
          columnId,
        ]);
        const position = asNumber(maxResult.rows[0].max_position) + POSITION_STEP;
        const id = randomUUID();

        await db.query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)', [
          id,
          columnId,
          text,
          position,
        ]);

        await db.query('COMMIT');
        return await getCardById(id);
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });

    await broadcastMutation('create', { card, columnId: card.column_id });
    res.status(201).json({ card, board: await getBoardState() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const id = req.params.id;
    const columnId = String(req.body?.columnId || req.body?.column_id || '').trim();
    const beforeId = req.body?.beforeId || null;
    const afterId = req.body?.afterId || null;

    if (!columnId) throw httpError(400, 'columnId is required.');
    if (beforeId && beforeId === id) throw httpError(400, 'beforeId cannot be the moved card.');
    if (afterId && afterId === id) throw httpError(400, 'afterId cannot be the moved card.');

    const result = await enqueueWrite(async () => {
      await db.query('BEGIN');
      try {
        const existingResult = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [id]);
        if (existingResult.rows.length === 0) throw httpError(404, 'Card not found.');
        const sourceColumnId = existingResult.rows[0].column_id;

        const columnResult = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (columnResult.rows.length === 0) throw httpError(404, 'Target column not found.');

        const cardsResult = await db.query(
          'SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
          [columnId, id],
        );
        const targetRows = cardsResult.rows.map((row) => ({ id: row.id, position: asNumber(row.position) }));
        const beforeIndex = beforeId ? targetRows.findIndex((card) => card.id === beforeId) : -1;
        const afterIndex = afterId ? targetRows.findIndex((card) => card.id === afterId) : -1;

        if (beforeId && beforeIndex === -1) throw httpError(400, 'beforeId is not in the target column.');
        if (afterId && afterIndex === -1) throw httpError(400, 'afterId is not in the target column.');

        let insertIndex;
        if (beforeId) insertIndex = beforeIndex;
        else if (afterId) insertIndex = afterIndex + 1;
        else insertIndex = targetRows.length;

        const { position, exhausted } = pickPosition(targetRows, insertIndex);
        let renormalized = exhausted;

        if (!renormalized) {
          await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, id]);

          const collision = await db.query(
            `SELECT position, COUNT(*)::int AS count
             FROM cards
             WHERE column_id = $1
             GROUP BY position
             HAVING COUNT(*) > 1
             LIMIT 1`,
            [columnId],
          );
          renormalized = collision.rows.length > 0;
        }

        if (renormalized) {
          const orderedIds = targetRows.map((card) => card.id);
          orderedIds.splice(insertIndex, 0, id);
          await db.query('UPDATE cards SET column_id = $1 WHERE id = $2', [columnId, id]);
          await renormalizeColumn(columnId, orderedIds);
        }

        await db.query('COMMIT');
        return { card: await getCardById(id), sourceColumnId, renormalized };
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });

    await broadcastMutation('move', {
      card: result.card,
      columnId: result.card.column_id,
      sourceColumnId: result.sourceColumnId,
      renormalized: result.renormalized,
    });

    if (result.renormalized) {
      const board = await getBoardState();
      const column = board.columns.find((candidate) => candidate.id === result.card.column_id);
      broadcast('column-order', { columnId: result.card.column_id, cards: column?.cards || [] });
    }

    res.json({ card: result.card, board: await getBoardState() });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(ROOT, 'dist')));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'dist', 'index.html'));
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATABASE_DIR}`);
});
