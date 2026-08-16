import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.resolve(process.cwd(), 'pgdata');
const POSITION_STEP = 1000;
const POSITION_EPSILON = 1e-7;

const app = express();
const db = new PGlite(DATA_DIR);
const sseClients = new Set();

// PGLite runs in-process. This queue serializes write transactions so two
// gestures that race on the same card/column are applied in a single canonical
// order before we broadcast committed state.
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

app.use(cors());
app.use(express.json());

async function query(sql, params = []) {
  return db.query(sql, params);
}

async function rollbackQuietly() {
  try {
    await query('ROLLBACK');
  } catch {
    // Ignore rollback failures; preserve the original error.
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
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

  await query(`CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position, id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id);`);

  const existing = await query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
    }
  }
}

function normalizeCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    column_id: row.column_id,
    text: row.text,
    position: Number(row.position),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function getBoardState() {
  const columnsResult = await query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await query(`
    SELECT id, column_id, text, position, created_at
    FROM cards
  `);

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: []
  }));

  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const cardRow of cardsResult.rows) {
    const column = byId.get(cardRow.column_id);
    if (column) column.cards.push(normalizeCard(cardRow));
  }

  // Cards are already globally sorted by column_id/position; sort inside each
  // rendered column too so the order is stable regardless of column id order.
  for (const column of columns) {
    column.cards.sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  }

  return { columns };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastBoard(eventType, board, payload = {}) {
  const message = { type: eventType, ...payload, board };
  for (const client of sseClients) {
    sendSse(client, 'board', message);
  }
}

async function renormalizeColumn(columnId) {
  const result = await query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );

  let next = POSITION_STEP;
  for (const row of result.rows) {
    await query('UPDATE cards SET position = $1 WHERE id = $2', [next, row.id]);
    next += POSITION_STEP;
  }
}

async function getNeighborPosition(id, columnId, movingCardId) {
  if (!id || id === movingCardId) return null;
  const result = await query('SELECT id, column_id, position FROM cards WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row || row.column_id !== columnId) return null;
  return Number(row.position);
}

async function maxPositionInColumn(columnId, excludingCardId = null) {
  const result = excludingCardId
    ? await query('SELECT MAX(position) AS max FROM cards WHERE column_id = $1 AND id <> $2', [columnId, excludingCardId])
    : await query('SELECT MAX(position) AS max FROM cards WHERE column_id = $1', [columnId]);
  return result.rows[0].max == null ? null : Number(result.rows[0].max);
}

async function computePosition({ columnId, beforeId, afterId, movingCardId }) {
  let before = await getNeighborPosition(beforeId, columnId, movingCardId);
  let after = await getNeighborPosition(afterId, columnId, movingCardId);

  if (before == null && after == null) {
    const max = await maxPositionInColumn(columnId, movingCardId);
    return max == null ? POSITION_STEP : max + POSITION_STEP;
  }

  if (before == null) {
    return after + POSITION_STEP;
  }

  if (after == null) {
    return before - POSITION_STEP;
  }

  if (after >= before || before - after <= POSITION_EPSILON) {
    await renormalizeColumn(columnId);
    before = await getNeighborPosition(beforeId, columnId, movingCardId);
    after = await getNeighborPosition(afterId, columnId, movingCardId);

    if (before == null && after == null) {
      const max = await maxPositionInColumn(columnId, movingCardId);
      return max == null ? POSITION_STEP : max + POSITION_STEP;
    }
    if (before == null) return after + POSITION_STEP;
    if (after == null) return before - POSITION_STEP;
  }

  const position = after + (before - after) / 2;
  if (!Number.isFinite(position) || Math.abs(position - after) <= POSITION_EPSILON || Math.abs(before - position) <= POSITION_EPSILON) {
    await renormalizeColumn(columnId);
    before = await getNeighborPosition(beforeId, columnId, movingCardId);
    after = await getNeighborPosition(afterId, columnId, movingCardId);
    if (before == null && after == null) {
      const max = await maxPositionInColumn(columnId, movingCardId);
      return max == null ? POSITION_STEP : max + POSITION_STEP;
    }
    if (before == null) return after + POSITION_STEP;
    if (after == null) return before - POSITION_STEP;
    return after + (before - after) / 2;
  }

  return position;
}

app.get('/api/board', async (req, res, next) => {
  try {
    res.json(await getBoardState());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  sendSse(res, 'board', { type: 'connected', board: await getBoardState() });

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
    const { columnId, text } = req.body ?? {};
    const trimmed = String(text ?? '').trim();
    if (!columnId || !trimmed) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const result = await enqueueWrite(async () => {
      await query('BEGIN');
      try {
        const columnResult = await query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (columnResult.rows.length === 0) {
          throw Object.assign(new Error('Column not found'), { statusCode: 404 });
        }

        const max = await maxPositionInColumn(columnId);
        const id = randomUUID();
        const position = max == null ? POSITION_STEP : max + POSITION_STEP;
        const insertResult = await query(
          `INSERT INTO cards (id, column_id, text, position)
           VALUES ($1, $2, $3, $4)
           RETURNING id, column_id, text, position, created_at`,
          [id, columnId, trimmed, position]
        );
        await query('COMMIT');
        const card = normalizeCard(insertResult.rows[0]);
        const board = await getBoardState();
        broadcastBoard('card_created', board, { card, columnId: card.column_id });
        return { card, board };
      } catch (error) {
        await rollbackQuietly();
        throw error;
      }
    });

    res.status(201).json({ card: result.card });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const result = await enqueueWrite(async () => {
      await query('BEGIN');
      try {
        const cardResult = await query('SELECT id, column_id, position FROM cards WHERE id = $1', [cardId]);
        if (cardResult.rows.length === 0) {
          throw Object.assign(new Error('Card not found'), { statusCode: 404 });
        }

        const columnResult = await query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (columnResult.rows.length === 0) {
          throw Object.assign(new Error('Column not found'), { statusCode: 404 });
        }

        const previousColumnId = cardResult.rows[0].column_id;
        const position = await computePosition({ columnId, beforeId, afterId, movingCardId: cardId });
        const updateResult = await query(
          `UPDATE cards
           SET column_id = $1, position = $2
           WHERE id = $3
           RETURNING id, column_id, text, position, created_at`,
          [columnId, position, cardId]
        );

        // If a pathological float edge still left neighboring positions too
        // close, space the final target column out again. The subsequent board
        // broadcast carries this corrected canonical order to every client.
        const closeNeighbors = await query(
          `SELECT COUNT(*)::int AS count
           FROM (
             SELECT position - LAG(position) OVER (ORDER BY position ASC, created_at ASC, id ASC) AS gap
             FROM cards
             WHERE column_id = $1
           ) gaps
           WHERE gap IS NOT NULL AND gap <= $2`,
          [columnId, POSITION_EPSILON]
        );
        if (Number(closeNeighbors.rows[0].count) > 0) {
          await renormalizeColumn(columnId);
        }

        const canonicalResult = await query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [cardId]
        );
        await query('COMMIT');
        const card = normalizeCard(canonicalResult.rows[0]);
        const board = await getBoardState();
        broadcastBoard('card_moved', board, { card, columnId: card.column_id, previousColumnId });
        return { card, previousColumnId, board };
      } catch (error) {
        await rollbackQuietly();
        throw error;
      }
    });

    res.json({ card: result.card });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.resolve(__dirname, '..', 'client', 'dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.resolve(__dirname, '..', 'client', 'dist', 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
