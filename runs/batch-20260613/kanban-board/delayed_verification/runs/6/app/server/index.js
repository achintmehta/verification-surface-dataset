import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), 'data', 'pglite');
const STEP = 1024;
const EPSILON = 1e-9;

const app = express();
const db = new PGlite(DATA_DIR);
const clients = new Set();
let dbQueue = Promise.resolve();

app.use(cors());
app.use(express.json());

function asNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

function normalizeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: asNumber(row.position),
    createdAt: row.created_at
  };
}

function withDbLock(work) {
  const run = dbQueue.then(work, work);
  dbQueue = run.catch(() => {});
  return run;
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS "columns" (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES "columns"(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);`);

  const existing = await db.query(`SELECT COUNT(*)::int AS count FROM "columns";`);
  if (Number(existing.rows[0].count) === 0) {
    await db.query(
      `INSERT INTO "columns" (id, title, position) VALUES
        ('todo', 'To Do', 1),
        ('in-progress', 'In Progress', 2),
        ('done', 'Done', 3);`
    );
  }
}

async function readBoardNow() {
  const columnsResult = await db.query(`SELECT id, title, position FROM "columns" ORDER BY position ASC, id ASC;`);
  const cardsResult = await db.query(`SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC;`);

  const columns = columnsResult.rows.map((column) => ({
    id: column.id,
    title: column.title,
    position: asNumber(column.position),
    cards: []
  }));

  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const row of cardsResult.rows) {
    const column = byId.get(row.column_id);
    if (column) column.cards.push(normalizeCard(row));
  }

  return { columns };
}

async function getBoard() {
  return dbQueue.then(readBoardNow);
}

async function getCanonicalCard(id) {
  const result = await db.query(
    `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;`,
    [id]
  );
  return result.rows[0] ? normalizeCard(result.rows[0]) : null;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    try {
      sseWrite(client, event, data);
    } catch {
      clients.delete(client);
    }
  }
}

async function broadcastBoard() {
  broadcast('board', await getBoard());
}

async function renormalizeColumn(columnId) {
  const cards = await db.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;`,
    [columnId]
  );

  let index = 1;
  for (const card of cards.rows) {
    await db.query(`UPDATE cards SET position = $1 WHERE id = $2;`, [index * STEP, card.id]);
    index += 1;
  }
}

async function columnNeedsRenormalization(columnId) {
  const rows = await db.query(
    `SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC;`,
    [columnId]
  );

  let previous = null;
  for (const row of rows.rows) {
    const current = asNumber(row.position);
    if (!Number.isFinite(current)) return true;
    if (previous !== null && Math.abs(current - previous) <= EPSILON) return true;
    previous = current;
  }
  return false;
}

async function getBoundaryPosition(boundaryId, columnId, movingCardId) {
  if (!boundaryId || boundaryId === movingCardId) return null;
  const result = await db.query(
    `SELECT position FROM cards WHERE id = $1 AND column_id = $2;`,
    [boundaryId, columnId]
  );
  // Concurrent collaborators can make a client's boundary hint stale. Treat a
  // missing boundary as an open end instead of failing the move; the server still
  // computes and broadcasts the canonical final position.
  if (!result.rows[0]) return null;
  return asNumber(result.rows[0].position);
}

async function computePosition({ columnId, beforeId = null, afterId = null, movingCardId = null }) {
  const beforePosition = await getBoundaryPosition(beforeId, columnId, movingCardId);
  const afterPosition = await getBoundaryPosition(afterId, columnId, movingCardId);

  if (beforePosition !== null && afterPosition !== null) {
    const lower = Math.min(beforePosition, afterPosition);
    const upper = Math.max(beforePosition, afterPosition);
    const midpoint = (lower + upper) / 2;
    if (Number.isFinite(midpoint) && midpoint > lower && midpoint < upper) {
      return { position: midpoint, renormalizedFirst: false };
    }
  } else if (beforePosition !== null) {
    const position = beforePosition / 2;
    if (Number.isFinite(position) && Math.abs(position - beforePosition) > EPSILON) {
      return { position, renormalizedFirst: false };
    }
  } else if (afterPosition !== null) {
    const position = afterPosition + STEP;
    if (Number.isFinite(position) && Math.abs(position - afterPosition) > EPSILON) {
      return { position, renormalizedFirst: false };
    }
  } else {
    const result = await db.query(
      `SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1 AND ($2::text IS NULL OR id <> $2);`,
      [columnId, movingCardId]
    );
    return { position: asNumber(result.rows[0].max_position) + STEP, renormalizedFirst: false };
  }

  await renormalizeColumn(columnId);

  const refreshedBeforePosition = await getBoundaryPosition(beforeId, columnId, movingCardId);
  const refreshedAfterPosition = await getBoundaryPosition(afterId, columnId, movingCardId);

  if (refreshedBeforePosition !== null && refreshedAfterPosition !== null) {
    return { position: (Math.min(refreshedBeforePosition, refreshedAfterPosition) + Math.max(refreshedBeforePosition, refreshedAfterPosition)) / 2, renormalizedFirst: true };
  }
  if (refreshedBeforePosition !== null) {
    return { position: refreshedBeforePosition / 2, renormalizedFirst: true };
  }
  if (refreshedAfterPosition !== null) {
    return { position: refreshedAfterPosition + STEP, renormalizedFirst: true };
  }

  return { position: STEP, renormalizedFirst: true };
}

async function createCard(columnId, text) {
  return withDbLock(async () => {
    const column = await db.query(`SELECT id FROM "columns" WHERE id = $1;`, [columnId]);
    if (!column.rows[0]) {
      const error = new Error('Column not found');
      error.status = 404;
      throw error;
    }

    const id = randomUUID();
    let inTransaction = false;
    await db.query('BEGIN;');
    inTransaction = true;
    try {
      const result = await db.query(
        `SELECT COALESCE(MAX(position), 0) + $2 AS position FROM cards WHERE column_id = $1;`,
        [columnId, STEP]
      );
      const position = asNumber(result.rows[0].position);
      await db.query(
        `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);`,
        [id, columnId, text, position]
      );
      if (await columnNeedsRenormalization(columnId)) await renormalizeColumn(columnId);
      await db.query('COMMIT;');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) await db.query('ROLLBACK;');
      throw error;
    }

    return getCanonicalCard(id);
  });
}

async function moveCard(id, columnId, beforeId, afterId) {
  return withDbLock(async () => {
    let inTransaction = false;
    await db.query('BEGIN;');
    inTransaction = true;
    let sourceColumnId = null;
    let renormalized = false;
    try {
      const targetColumn = await db.query(`SELECT id FROM "columns" WHERE id = $1;`, [columnId]);
      if (!targetColumn.rows[0]) {
        const error = new Error('Target column not found');
        error.status = 404;
        throw error;
      }

      const existing = await db.query(`SELECT id, column_id FROM cards WHERE id = $1;`, [id]);
      if (!existing.rows[0]) {
        const error = new Error('Card not found');
        error.status = 404;
        throw error;
      }
      sourceColumnId = existing.rows[0].column_id;

      // Ensure the moving card cannot serve as its own boundary.
      if (beforeId === id) beforeId = null;
      if (afterId === id) afterId = null;

      const computed = await computePosition({ columnId, beforeId, afterId, movingCardId: id });
      renormalized = computed.renormalizedFirst;

      await db.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;`,
        [columnId, computed.position, id]
      );

      if (await columnNeedsRenormalization(columnId)) {
        await renormalizeColumn(columnId);
        renormalized = true;
      }
      if (sourceColumnId !== columnId && await columnNeedsRenormalization(sourceColumnId)) {
        await renormalizeColumn(sourceColumnId);
        renormalized = true;
      }

      await db.query('COMMIT;');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) await db.query('ROLLBACK;');
      throw error;
    }

    return { card: await getCanonicalCard(id), sourceColumnId, renormalized };
  });
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
    const { columnId, text } = req.body || {};
    const cleanText = String(text || '').trim();
    if (!columnId || !cleanText) return res.status(400).json({ error: 'columnId and non-empty text are required' });

    const card = await createCard(columnId, cleanText);
    const payload = { card, columnId: card.columnId };
    broadcast('create', payload);
    await broadcastBoard();
    res.status(201).json(payload);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });

    const result = await moveCard(req.params.id, columnId, beforeId, afterId);
    const payload = {
      card: result.card,
      columnId: result.card.columnId,
      sourceColumnId: result.sourceColumnId,
      renormalized: result.renormalized
    };
    broadcast('move', payload);
    await broadcastBoard();
    res.json(payload);
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

    clients.add(res);
    sseWrite(res, 'connected', { at: new Date().toISOString() });
    sseWrite(res, 'board', await getBoard());

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  } catch (error) {
    next(error);
  }
});

const staticDist = path.join(process.cwd(), 'frontend', 'dist');
app.use(express.static(staticDist));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(staticDist, 'index.html');
  res.sendFile(indexPath, (error) => {
    if (error) res.status(404).send('Frontend not built. Run npm run dev for development or npm run build first.');
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal Server Error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban server listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
