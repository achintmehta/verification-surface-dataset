import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const POSITION_STEP = 1000;
const POSITION_EPSILON = 1e-9;

const dataDir = process.env.PGLITE_DATA_DIR || './data/pglite';
fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const db = new PGlite(dataDir);
const clients = new Set();
let writeQueue = Promise.resolve();

app.use(cors());
app.use(express.json());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function enqueueWrite(work) {
  const run = writeQueue.then(work, work);
  writeQueue = run.catch(() => undefined);
  return run;
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

function normalizeCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    columnId: row.column_id ?? row.columnId,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at ?? row.createdAt
  };
}

async function getCard(id) {
  const result = await db.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;', [id]);
  return normalizeCard(result.rows[0]);
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC;');
  const cardsResult = await db.query(`
    SELECT id, column_id, text, position, created_at
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;
  `);

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: Number(column.position),
    cards: []
  }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const row of cardsResult.rows) {
    const column = byId.get(row.column_id);
    if (column) column.cards.push(normalizeCard(row));
  }
  return { columns };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    try {
      sendSse(res, event, data);
    } catch {
      clients.delete(res);
    }
  }
}

async function broadcastBoard() {
  const board = await getBoard();
  broadcast('board', board);
  return board;
}

async function renormalizeColumn(columnId, excludingCardId = null) {
  const params = excludingCardId ? [columnId, excludingCardId] : [columnId];
  const whereExclusion = excludingCardId ? 'AND id <> $2' : '';
  const result = await db.query(`
    SELECT id
    FROM cards
    WHERE column_id = $1 ${whereExclusion}
    ORDER BY position ASC, created_at ASC, id ASC;
  `, params);

  for (let i = 0; i < result.rows.length; i += 1) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2;', [(i + 1) * POSITION_STEP, result.rows[i].id]);
  }
}

function computePosition(cards, beforeId, afterId) {
  const before = beforeId ? cards.find((card) => card.id === beforeId) : null;
  const after = afterId ? cards.find((card) => card.id === afterId) : null;

  let position;
  if (before && after) {
    position = (Number(before.position) + Number(after.position)) / 2;
  } else if (after) {
    position = Number(after.position) + POSITION_STEP;
  } else if (before) {
    position = Math.min(Number(before.position) / 2, Number(before.position) - POSITION_STEP);
  } else if (cards.length > 0) {
    position = Number(cards[cards.length - 1].position) + POSITION_STEP;
  } else {
    position = POSITION_STEP;
  }

  return { position, before, after };
}

function needsRenormalization(position, before, after) {
  if (!Number.isFinite(position)) return true;
  if (Math.abs(position) > Number.MAX_SAFE_INTEGER / 2) return true;
  if (before && after && Math.abs(Number(before.position) - position) < POSITION_EPSILON) return true;
  if (before && after && Math.abs(position - Number(after.position)) < POSITION_EPSILON) return true;
  if (before && after && Math.abs(Number(before.position) - Number(after.position)) < POSITION_EPSILON) return true;
  return false;
}

async function getTargetCards(columnId, movingCardId) {
  const result = await db.query(`
    SELECT id, position, created_at
    FROM cards
    WHERE column_id = $1 AND id <> $2
    ORDER BY position ASC, created_at ASC, id ASC;
  `, [columnId, movingCardId]);
  return result.rows.map((row) => ({ id: row.id, position: Number(row.position), createdAt: row.created_at }));
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
  const columnId = String(req.body.columnId || '');
  const text = String(req.body.text || '').trim();

  if (!columnId || !text) {
    res.status(400).json({ error: 'columnId and non-empty text are required' });
    return;
  }

  try {
    const card = await enqueueWrite(async () => {
      const id = randomUUID();
      await db.query('BEGIN;');
      try {
        const column = await db.query('SELECT id FROM columns WHERE id = $1;', [columnId]);
        if (column.rows.length === 0) throw new HttpError(404, 'Column not found');

        const max = await db.query('SELECT COALESCE(MAX(position), 0) AS position FROM cards WHERE column_id = $1;', [columnId]);
        let position = Number(max.rows[0].position) + POSITION_STEP;
        if (!Number.isFinite(position) || Math.abs(position) > Number.MAX_SAFE_INTEGER / 2) {
          await renormalizeColumn(columnId);
          const normalizedMax = await db.query('SELECT COALESCE(MAX(position), 0) AS position FROM cards WHERE column_id = $1;', [columnId]);
          position = Number(normalizedMax.rows[0].position) + POSITION_STEP;
        }
        await db.query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);', [id, columnId, text, position]);
        await db.query('COMMIT;');
        return await getCard(id);
      } catch (error) {
        await db.query('ROLLBACK;');
        throw error;
      }
    });

    res.status(201).json({ card });
    broadcast('create', { card, columnId: card.columnId });
    await broadcastBoard();
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  const id = req.params.id;
  const columnId = String(req.body.columnId || '');
  const beforeId = req.body.beforeId ? String(req.body.beforeId) : null;
  const afterId = req.body.afterId ? String(req.body.afterId) : null;

  if (!columnId) {
    res.status(400).json({ error: 'columnId is required' });
    return;
  }

  try {
    const card = await enqueueWrite(async () => {
      await db.query('BEGIN;');
      try {
        const column = await db.query('SELECT id FROM columns WHERE id = $1;', [columnId]);
        if (column.rows.length === 0) throw new HttpError(404, 'Column not found');

        const existing = await db.query('SELECT id FROM cards WHERE id = $1;', [id]);
        if (existing.rows.length === 0) throw new HttpError(404, 'Card not found');

        let cards = await getTargetCards(columnId, id);
        let { position, before, after } = computePosition(cards, beforeId, afterId);

        if (needsRenormalization(position, before, after)) {
          await renormalizeColumn(columnId, id);
          cards = await getTargetCards(columnId, id);
          ({ position, before, after } = computePosition(cards, beforeId, afterId));
        }

        if (needsRenormalization(position, before, after)) {
          // Extremely defensive fallback: put the card at the end after a full normalization.
          await renormalizeColumn(columnId, id);
          cards = await getTargetCards(columnId, id);
          position = cards.length > 0 ? Number(cards[cards.length - 1].position) + POSITION_STEP : POSITION_STEP;
        }

        await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;', [columnId, position, id]);
        await db.query('COMMIT;');
        return await getCard(id);
      } catch (error) {
        await db.query('ROLLBACK;');
        throw error;
      }
    });

    res.json({ card });
    broadcast('move', { card, columnId: card.columnId });
    await broadcastBoard();
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  clients.add(res);
  sendSse(res, 'connected', { ok: true });
  sendSse(res, 'board', await getBoard());

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

const distPath = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (!res.headersSent) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error' });
  }
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
});
