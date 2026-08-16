import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const GAP = 1000;
const EPSILON = 1e-9;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const db = new PGlite(path.join(rootDir, 'pglite-data'));
const clients = new Set();
let revision = 0;

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, payload) {
  const message = { ...payload, revision: ++revision };
  for (const res of clients) {
    try {
      sendSse(res, event, message);
    } catch {
      clients.delete(res);
    }
  }
}

function rowToCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

function rowToColumn(row) {
  return {
    id: row.id,
    title: row.title,
    position: Number(row.position),
    cards: [],
  };
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(countResult.rows[0].count) === 0) {
    await db.exec('BEGIN');
    try {
      const defaults = [
        ['todo', 'To Do', 1000],
        ['in-progress', 'In Progress', 2000],
        ['done', 'Done', 3000],
      ];
      for (const [id, title, position] of defaults) {
        await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }
}

async function getBoard() {
  const [columnResult, cardResult] = await Promise.all([
    db.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'),
    db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'),
  ]);

  const columns = columnResult.rows.map(rowToColumn);
  const columnById = new Map(columns.map((column) => [column.id, column]));
  for (const row of cardResult.rows) {
    const card = rowToCard(row);
    const column = columnById.get(card.columnId);
    if (column) column.cards.push(card);
  }
  return { columns, revision };
}

async function getCard(id) {
  const result = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [id],
  );
  return result.rows[0] ? rowToCard(result.rows[0]) : null;
}

async function columnExists(columnId) {
  const result = await db.query('SELECT 1 FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function getBoundaryPosition(cardId, targetColumnId, movingCardId, label) {
  if (cardId == null || cardId === '') return null;
  if (cardId === movingCardId) return null;

  const result = await db.query(
    'SELECT column_id, position FROM cards WHERE id = $1',
    [cardId],
  );
  if (result.rows.length === 0) {
    const err = new Error(`${label} card was not found`);
    err.status = 400;
    throw err;
  }
  if (result.rows[0].column_id !== targetColumnId) {
    const err = new Error(`${label} card is not in the target column`);
    err.status = 400;
    throw err;
  }
  return Number(result.rows[0].position);
}

async function computePosition(columnId, movingCardId, beforeId, afterId) {
  let beforePosition = await getBoundaryPosition(beforeId, columnId, movingCardId, 'beforeId');
  let afterPosition = await getBoundaryPosition(afterId, columnId, movingCardId, 'afterId');

  if (afterPosition == null && beforePosition == null) {
    const maxResult = await db.query(
      'SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1 AND id <> $2',
      [columnId, movingCardId || ''],
    );
    const maxPosition = maxResult.rows[0].max_position;
    return maxPosition == null ? GAP : Number(maxPosition) + GAP;
  }

  if (afterPosition == null) {
    return beforePosition - GAP;
  }

  if (beforePosition == null) {
    return afterPosition + GAP;
  }

  if (afterPosition >= beforePosition) {
    const err = new Error('afterId must come before beforeId in the target column');
    err.status = 400;
    throw err;
  }

  return (afterPosition + beforePosition) / 2;
}

async function renormalizeColumn(columnId) {
  const result = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId],
  );

  const normalized = [];
  for (let i = 0; i < result.rows.length; i += 1) {
    const position = (i + 1) * GAP;
    const id = result.rows[i].id;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
    normalized.push({ id, position });
  }
  return normalized;
}

async function needsRenormalization(columnId) {
  const result = await db.query(
    `SELECT position,
            LAG(position) OVER (ORDER BY position ASC, created_at ASC, id ASC) AS previous_position
       FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId],
  );

  const seen = new Set();
  for (const row of result.rows) {
    const current = Number(row.position);
    if (!Number.isFinite(current) || seen.has(current)) return true;
    seen.add(current);
    if (row.previous_position != null) {
      const previous = Number(row.previous_position);
      if (Math.abs(current - previous) < EPSILON) return true;
    }
  }
  return false;
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

app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
      clients.delete(res);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  const { columnId, text } = req.body || {};
  const cleanText = String(text || '').trim();

  if (!columnId || !cleanText) {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    if (!(await columnExists(columnId))) {
      return res.status(404).json({ error: 'Column not found' });
    }

    const id = randomUUID();
    let card;
    await db.exec('BEGIN');
    try {
      const maxResult = await db.query('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1', [columnId]);
      const position = maxResult.rows[0].max_position == null ? GAP : Number(maxResult.rows[0].max_position) + GAP;
      const insertResult = await db.query(
        `INSERT INTO cards (id, column_id, text, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id, column_id, text, position, created_at`,
        [id, columnId, cleanText, position],
      );
      card = rowToCard(insertResult.rows[0]);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    broadcast('card:create', { card, columnId: card.columnId });
    res.status(201).json({ card });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body || {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    if (!(await columnExists(columnId))) {
      return res.status(404).json({ error: 'Column not found' });
    }

    const previous = await getCard(id);
    if (!previous) {
      return res.status(404).json({ error: 'Card not found' });
    }

    let card;
    let normalizedColumn = null;
    await db.exec('BEGIN');
    try {
      const position = await computePosition(columnId, id, beforeId, afterId);
      const updateResult = await db.query(
        `UPDATE cards
            SET column_id = $1,
                position = $2
          WHERE id = $3
          RETURNING id, column_id, text, position, created_at`,
        [columnId, position, id],
      );
      card = rowToCard(updateResult.rows[0]);

      if (await needsRenormalization(columnId)) {
        await renormalizeColumn(columnId);
        normalizedColumn = (await getBoard()).columns.find((column) => column.id === columnId) || null;
        card = await getCard(id);
      }

      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    broadcast('card:move', {
      card,
      columnId: card.columnId,
      previousColumnId: previous.columnId,
      normalizedColumn,
    });
    res.json({ card, normalizedColumn });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
if (!isProduction) {
  app.use(express.static(path.join(rootDir, 'public')));
}
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const distIndex = path.join(rootDir, 'dist', 'index.html');
  const publicIndex = path.join(rootDir, 'index.html');
  res.sendFile(isProduction ? distIndex : publicIndex, (error) => {
    if (error) next();
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kanban server listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
