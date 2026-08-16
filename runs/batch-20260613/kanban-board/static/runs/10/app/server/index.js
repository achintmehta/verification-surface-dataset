import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.PGLITE_DATA_DIR || './.pglite';
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 0.000001;

await mkdir(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();
let mutationQueue = Promise.resolve();

function enqueueMutation(work) {
  const run = mutationQueue.then(work, work);
  mutationQueue = run.catch((error) => {
    console.error('Queued mutation failed:', error);
  });
  return run;
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const client of clients) {
    sendSse(client, event, payload);
  }
}

function toColumn(row) {
  return {
    id: row.id,
    title: row.title,
    position: Number(row.position),
    cards: []
  };
}

function toCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);');

  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns;');
  if (Number(existing.rows[0].count) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];

    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3);', [id, title, position]);
    }
  }
}

async function getBoardState() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;');
  const cardsResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;');

  const columns = columnsResult.rows.map(toColumn);
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const row of cardsResult.rows) {
    const card = toCard(row);
    const column = byId.get(card.columnId);
    if (column) column.cards.push(card);
  }

  return { columns };
}

async function getCard(id) {
  const result = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [id]);
  return result.rows[0] ? toCard(result.rows[0]) : null;
}

async function columnExists(columnId) {
  const result = await db.query('SELECT 1 FROM columns WHERE id = $1;', [columnId]);
  return result.rows.length > 0;
}

async function renormalizeColumn(columnId) {
  const result = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId]
  );

  for (let index = 0; index < result.rows.length; index += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2;', [(index + 1) * POSITION_STEP, result.rows[index].id]);
  }
}

async function columnNeedsRenormalization(columnId) {
  const result = await db.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;',
    [columnId]
  );

  let previous = null;
  for (const row of result.rows) {
    const current = Number(row.position);
    if (!Number.isFinite(current)) return true;
    if (previous !== null && current - previous < MIN_POSITION_GAP) return true;
    previous = current;
  }
  return false;
}

async function computePosition(columnId, beforeId, afterId, movingCardId = null) {
  let beforePosition = null;
  let afterPosition = null;

  if (beforeId) {
    if (beforeId === movingCardId) {
      throw Object.assign(new Error('beforeId cannot be the moving card'), { status: 400 });
    }
    const before = await db.query('SELECT column_id, position FROM cards WHERE id = $1;', [beforeId]);
    if (before.rows.length === 0) throw Object.assign(new Error('beforeId was not found'), { status: 400 });
    if (before.rows[0].column_id !== columnId) {
      throw Object.assign(new Error('beforeId must be in the target column'), { status: 400 });
    }
    beforePosition = Number(before.rows[0].position);
  }

  if (afterId) {
    if (afterId === movingCardId) {
      throw Object.assign(new Error('afterId cannot be the moving card'), { status: 400 });
    }
    const after = await db.query('SELECT column_id, position FROM cards WHERE id = $1;', [afterId]);
    if (after.rows.length === 0) throw Object.assign(new Error('afterId was not found'), { status: 400 });
    if (after.rows[0].column_id !== columnId) {
      throw Object.assign(new Error('afterId must be in the target column'), { status: 400 });
    }
    afterPosition = Number(after.rows[0].position);
  }

  if (beforePosition !== null && afterPosition !== null && !(afterPosition < beforePosition)) {
    throw Object.assign(new Error('afterId must refer to a card ordered before beforeId'), { status: 400 });
  }

  if (beforePosition !== null && afterPosition !== null) return (beforePosition + afterPosition) / 2;
  if (beforePosition !== null) return beforePosition / 2;
  if (afterPosition !== null) return afterPosition + POSITION_STEP;

  const maxResult = await db.query('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1;', [columnId]);
  const maxPosition = maxResult.rows[0].max_position === null ? 0 : Number(maxResult.rows[0].max_position);
  return maxPosition + POSITION_STEP;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

async function waitForPendingMutations() {
  await mutationQueue.catch(() => {});
}

app.get('/api/board', async (_req, res, next) => {
  try {
    await waitForPendingMutations();
    res.json(await getBoardState());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res, next) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  try {
    await waitForPendingMutations();
  } catch (error) {
    next(error);
    return;
  }

  clients.add(res);
  sendSse(res, 'connected', { ok: true });
  sendSse(res, 'board:sync', await getBoardState());

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
    const result = await enqueueMutation(async () => {
      const columnId = String(req.body?.columnId || '');
      const text = String(req.body?.text || '').trim();

      if (!columnId) throw Object.assign(new Error('columnId is required'), { status: 400 });
      if (!text) throw Object.assign(new Error('Card text is required'), { status: 400 });
      if (!(await columnExists(columnId))) throw Object.assign(new Error('Column not found'), { status: 404 });

      let card;
      let board;
      await db.query('BEGIN;');
      try {
        const position = await computePosition(columnId, null, null);
        const id = randomUUID();
        const inserted = await db.query(
          'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at;',
          [id, columnId, text, position]
        );

        if (await columnNeedsRenormalization(columnId)) {
          await renormalizeColumn(columnId);
        }

        await db.query('COMMIT;');
        card = (await getCard(inserted.rows[0].id)) || toCard(inserted.rows[0]);
        board = await getBoardState();
      } catch (error) {
        await db.query('ROLLBACK;');
        throw error;
      }

      const payload = { type: 'create', card, columnId: card.columnId };
      broadcast('card:create', payload);
      broadcast('board:sync', board);
      return { card, board };
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const result = await enqueueMutation(async () => {
      const id = req.params.id;
      const columnId = String(req.body?.columnId || '');
      const beforeId = req.body?.beforeId || null;
      const afterId = req.body?.afterId || null;

      if (!columnId) throw Object.assign(new Error('columnId is required'), { status: 400 });
      if (!(await columnExists(columnId))) throw Object.assign(new Error('Column not found'), { status: 404 });

      let card;
      let previousColumnId;
      let board;
      await db.query('BEGIN;');
      try {
        const existing = await db.query('SELECT column_id FROM cards WHERE id = $1;', [id]);
        if (existing.rows.length === 0) throw Object.assign(new Error('Card not found'), { status: 404 });
        previousColumnId = existing.rows[0].column_id;

        const removedPosition = -1;
        await db.query('UPDATE cards SET position = $1 WHERE id = $2;', [removedPosition, id]);
        const position = await computePosition(columnId, beforeId, afterId, id);
        const updated = await db.query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING id, column_id, text, position, created_at;',
          [columnId, position, id]
        );

        const affectedColumns = new Set([previousColumnId, columnId]);
        for (const affectedColumnId of affectedColumns) {
          if (await columnNeedsRenormalization(affectedColumnId)) {
            await renormalizeColumn(affectedColumnId);
          }
        }

        await db.query('COMMIT;');
        card = (await getCard(updated.rows[0].id)) || toCard(updated.rows[0]);
        board = await getBoardState();
      } catch (error) {
        await db.query('ROLLBACK;');
        throw error;
      }

      const payload = { type: 'move', card, columnId: card.columnId, previousColumnId };
      broadcast('card:move', payload);
      broadcast('board:sync', board);
      return { card, board };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Internal Server Error' });
});

await initDb();

app.listen(PORT, () => {
  console.log(`Kanban API server listening on http://localhost:${PORT}`);
});
