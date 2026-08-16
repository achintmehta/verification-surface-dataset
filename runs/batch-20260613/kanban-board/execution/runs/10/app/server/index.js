import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || './.pglite';
const POSITION_STEP = 1000;
const MIN_GAP = 1e-9;

const db = new PGlite(DATA_DIR);
const app = express();

app.use(cors());
app.use(express.json());

const clients = new Set();
let mutationQueue = Promise.resolve();

function enqueueMutation(work) {
  const run = mutationQueue.then(work, work);
  mutationQueue = run.catch(() => {});
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
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if ((count.rows[0]?.count ?? 0) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];
    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
    }
  }
}

async function getBoard() {
  const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await db.query(`
    SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
    FROM cards
    ORDER BY column_id ASC, position ASC, created_at ASC, id ASC
  `);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.columnId);
    if (column) column.cards.push(card);
  }
  return { columns };
}

async function getCard(id) {
  const result = await db.query(
    'SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt" FROM cards WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function broadcast(event, payload) {
  const board = await getBoard();
  const envelope = { ...payload, board };
  for (const res of clients) {
    sendSse(res, event, envelope);
    // A full-board event makes convergence trivial for clients that missed an intent event
    // or had a conflicting optimistic local order.
    sendSse(res, 'board', board);
  }
}

async function renormalizeColumn(columnId) {
  const result = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );

  let position = POSITION_STEP;
  for (const row of result.rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, row.id]);
    position += POSITION_STEP;
  }
}

async function positionsForMove({ cardId, columnId, beforeId, afterId }) {
  const target = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId, cardId]
  );
  const rows = target.rows;

  let before = beforeId ? rows.find((row) => row.id === beforeId) : null;
  let after = afterId ? rows.find((row) => row.id === afterId) : null;

  // If a stale client supplied missing neighbours, fall back to a deterministic insertion
  // point instead of failing the move. The server remains authoritative.
  if (beforeId && !before) before = null;
  if (afterId && !after) after = null;

  let newPosition;
  let needsRenormalize = false;

  if (before && after && after.position < before.position) {
    const gap = before.position - after.position;
    newPosition = after.position + gap / 2;
    needsRenormalize = gap <= MIN_GAP || newPosition === before.position || newPosition === after.position;
  } else if (before) {
    // Inserting at the start of a column. Use a fractional value before the
    // current first card instead of shifting the whole column every time.
    newPosition = before.position / 2;
    needsRenormalize = newPosition <= MIN_GAP || newPosition === before.position;
  } else if (after) {
    newPosition = after.position + POSITION_STEP;
  } else {
    const max = rows.reduce((highest, row) => Math.max(highest, Number(row.position)), 0);
    newPosition = max + POSITION_STEP;
  }

  if (!Number.isFinite(newPosition)) needsRenormalize = true;
  return { newPosition, needsRenormalize };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (req, res, next) => {
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
    if (!columnId || !cleanText) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const card = await enqueueMutation(async () => {
      await db.exec('BEGIN');
      try {
        const column = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) {
          throw Object.assign(new Error('Column not found'), { status: 404 });
        }
        const maxResult = await db.query('SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1', [columnId]);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const position = Number(maxResult.rows[0].max) + POSITION_STEP;
        await db.query(
          'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
          [id, columnId, cleanText, position, createdAt]
        );
        await db.exec('COMMIT');
        return await getCard(id);
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    });

    await broadcast('card:create', { card, columnId: card.columnId });
    res.status(201).json({ card, board: await getBoard() });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }
    if (beforeId && beforeId === cardId) {
      return res.status(400).json({ error: 'beforeId cannot be the moved card' });
    }
    if (afterId && afterId === cardId) {
      return res.status(400).json({ error: 'afterId cannot be the moved card' });
    }

    const { card, renormalizedColumns } = await enqueueMutation(async () => {
      await db.exec('BEGIN');
      try {
        const existing = await getCard(cardId);
        if (!existing) throw Object.assign(new Error('Card not found'), { status: 404 });

        const column = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
        if (column.rows.length === 0) throw Object.assign(new Error('Column not found'), { status: 404 });

        const touched = new Set([existing.columnId, columnId]);
        let { newPosition, needsRenormalize } = await positionsForMove({ cardId, columnId, beforeId, afterId });

        if (needsRenormalize) {
          await renormalizeColumn(columnId);
          ({ newPosition } = await positionsForMove({ cardId, columnId, beforeId, afterId }));
          touched.add(columnId);
        }

        await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, newPosition, cardId]);

        // Detect exact duplicate positions after the authoritative move. If a collision happened
        // due to numeric precision or concurrent stale neighbour intent, renormalize the column.
        const duplicates = await db.query(
          `SELECT position, COUNT(*)::int AS count
           FROM cards
           WHERE column_id = $1
           GROUP BY position
           HAVING COUNT(*) > 1`,
          [columnId]
        );
        if (duplicates.rows.length > 0) {
          await renormalizeColumn(columnId);
          touched.add(columnId);
        }

        await db.exec('COMMIT');
        return { card: await getCard(cardId), renormalizedColumns: [...touched] };
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    });

    await broadcast('card:move', { card, columnId: card.columnId, renormalizedColumns });
    res.json({ card, board: await getBoard() });
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
  sendSse(res, 'board', await getBoard());

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((error, req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
});
