import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const POSITION_STEP = 1024;
const POSITION_EPSILON = 1e-9;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(rootDir, '.pglite-data'));
const clients = new Set();
let mutationQueue = Promise.resolve();

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch((err) => {
    console.error('Queued mutation failed:', err);
  });
  return run;
}

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
        ($1, 'To Do', 1024),
        ($2, 'In Progress', 2048),
        ($3, 'Done', 3072)`,
      ['todo', 'in-progress', 'done'],
    );
  }
}

function cardFromRow(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

async function getBoardState(client = db) {
  const [columnResult, cardResult] = await Promise.all([
    client.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    client.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, created_at ASC, id ASC'),
  ]);

  const columns = columnResult.rows.map((row) => ({
    id: row.id,
    title: row.title,
    position: Number(row.position),
    cards: [],
  }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const row of cardResult.rows) {
    const column = byId.get(row.column_id);
    if (column) column.cards.push(cardFromRow(row));
  }

  return { columns };
}

function sendSse(res, payload, eventName = 'message') {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(payload, eventName = 'message') {
  for (const res of clients) {
    try {
      sendSse(res, payload, eventName);
    } catch (err) {
      console.error('Failed to write SSE payload:', err);
      clients.delete(res);
    }
  }
}

async function broadcastBoard(extra = {}) {
  const board = await getBoardState();
  broadcast({ type: 'board', board, ...extra }, 'board');
}

function computePosition(orderedCards, beforeId, afterId) {
  const afterCard = afterId ? orderedCards.find((card) => card.id === afterId) : null;
  const beforeCard = beforeId ? orderedCards.find((card) => card.id === beforeId) : null;

  if (afterCard && beforeCard && afterCard.position < beforeCard.position) {
    const midpoint = (afterCard.position + beforeCard.position) / 2;
    if (Number.isFinite(midpoint) && midpoint > afterCard.position && midpoint < beforeCard.position && (beforeCard.position - afterCard.position) > POSITION_EPSILON) {
      return { position: midpoint, needsRenormalize: false };
    }
    return { position: null, needsRenormalize: true };
  }

  if (afterCard && !beforeId) {
    return { position: afterCard.position + POSITION_STEP, needsRenormalize: false };
  }

  if (!afterId && beforeCard) {
    return { position: beforeCard.position - POSITION_STEP, needsRenormalize: false };
  }

  if (!afterId && !beforeId) {
    if (orderedCards.length === 0) return { position: POSITION_STEP, needsRenormalize: false };
    const last = orderedCards[orderedCards.length - 1];
    return { position: last.position + POSITION_STEP, needsRenormalize: false };
  }

  // Stale or inconsistent neighbor ids. Prefer safe append; the server remains authoritative.
  const last = orderedCards[orderedCards.length - 1];
  return { position: last ? last.position + POSITION_STEP : POSITION_STEP, needsRenormalize: false };
}

async function renormalizeColumn(client, columnId, movingCard = null, requestedBeforeId = null, requestedAfterId = null) {
  const result = await client.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId],
  );

  let orderedIds = result.rows.map((row) => row.id).filter((id) => id !== movingCard?.id);

  if (movingCard) {
    const afterIndex = requestedAfterId ? orderedIds.indexOf(requestedAfterId) : -1;
    const beforeIndex = requestedBeforeId ? orderedIds.indexOf(requestedBeforeId) : -1;
    let insertIndex = orderedIds.length;

    if (requestedAfterId && afterIndex >= 0) insertIndex = afterIndex + 1;
    else if (requestedBeforeId && beforeIndex >= 0) insertIndex = beforeIndex;
    else if (!requestedAfterId && requestedBeforeId) insertIndex = beforeIndex >= 0 ? beforeIndex : 0;
    else if (!requestedAfterId && !requestedBeforeId) insertIndex = orderedIds.length;

    orderedIds.splice(Math.max(0, Math.min(insertIndex, orderedIds.length)), 0, movingCard.id);
  }

  for (let index = 0; index < orderedIds.length; index += 1) {
    await client.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, orderedIds[index]]);
  }

  if (!movingCard) return null;
  const moved = await client.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [movingCard.id]);
  return moved.rows[0] ? cardFromRow(moved.rows[0]) : null;
}

async function columnNeedsRenormalization(client, columnId) {
  const result = await client.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId],
  );
  let previous = null;
  for (const row of result.rows) {
    const position = Number(row.position);
    if (!Number.isFinite(position)) return true;
    if (previous !== null && Math.abs(position - previous) <= POSITION_EPSILON) return true;
    previous = position;
  }
  return false;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoardState());
  } catch (err) {
    next(err);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, { type: 'connected' }, 'connected');
  sendSse(res, { type: 'board', board: await getBoardState() }, 'board');

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body ?? {};
    const cleanText = String(text ?? '').trim();
    if (!columnId || !cleanText) return res.status(400).json({ error: 'columnId and non-empty text are required' });

    const result = await enqueueMutation(async () => {
      let createdCard;
      await db.transaction(async (tx) => {
        const column = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) {
          const err = new Error('Column not found');
          err.status = 404;
          throw err;
        }

        const maxPosition = await tx.query('SELECT COALESCE(MAX(position), 0) AS max_position FROM cards WHERE column_id = $1', [columnId]);
        const position = Number(maxPosition.rows[0].max_position) + POSITION_STEP;
        const id = randomUUID();
        const inserted = await tx.query(
          'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at',
          [id, columnId, cleanText, position],
        );
        createdCard = cardFromRow(inserted.rows[0]);
      });
      await broadcastBoard({ mutation: 'create', card: createdCard, columnId: createdCard.columnId });
      return createdCard;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body ?? {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    if (beforeId && beforeId === cardId) return res.status(400).json({ error: 'beforeId cannot be the moved card' });
    if (afterId && afterId === cardId) return res.status(400).json({ error: 'afterId cannot be the moved card' });

    const movedCard = await enqueueMutation(async () => {
      let canonicalCard;
      await db.transaction(async (tx) => {
        const targetColumn = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (targetColumn.rows.length === 0) {
          const err = new Error('Column not found');
          err.status = 404;
          throw err;
        }

        const existing = await tx.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
        if (existing.rows.length === 0) {
          const err = new Error('Card not found');
          err.status = 404;
          throw err;
        }

        const ordered = await tx.query(
          'SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
          [columnId, cardId],
        );
        const cards = ordered.rows.map((row) => ({ id: row.id, position: Number(row.position) }));
        const { position, needsRenormalize } = computePosition(cards, beforeId, afterId);

        if (!needsRenormalize) {
          const updated = await tx.query(
            'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING id, column_id, text, position, created_at',
            [columnId, position, cardId],
          );
          canonicalCard = cardFromRow(updated.rows[0]);

          if (await columnNeedsRenormalization(tx, columnId)) {
            canonicalCard = await renormalizeColumn(tx, columnId, canonicalCard, beforeId, afterId);
          }
        } else {
          await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, 0, cardId]);
          const row = await tx.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [cardId]);
          canonicalCard = await renormalizeColumn(tx, columnId, cardFromRow(row.rows[0]), beforeId, afterId);
        }
      });

      await broadcastBoard({ mutation: 'move', card: canonicalCard, columnId: canonicalCard.columnId });
      return canonicalCard;
    });

    res.json(movedCard);
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(rootDir, 'dist', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
});
