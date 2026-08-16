import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pglite-data');
const POSITION_STEP = 1000;

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(DATA_DIR);
const clients = new Set();

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

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');

  await db.query(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
      color TEXT NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$')
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    )
  `);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (Number(count.rows[0].count) === 0) {
    await db.query(
      `INSERT INTO columns (id, title, position) VALUES
        ('todo', 'To Do', 1000),
        ('in-progress', 'In Progress', 2000),
        ('done', 'Done', 3000)`
    );
  }
}

async function getLabelsForCards(cardIds, conn = db) {
  if (!cardIds.length) return new Map();
  const placeholders = cardIds.map((_, i) => `$${i + 1}`).join(',');
  const result = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
     FROM card_labels cl
     JOIN labels l ON l.id = cl.label_id
     WHERE cl.card_id IN (${placeholders})
     ORDER BY l.name ASC`,
    cardIds
  );
  const map = new Map();
  for (const row of result.rows) {
    if (!map.has(row.card_id)) map.set(row.card_id, []);
    map.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }
  return map;
}

async function getAllLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY name ASC');
  return result.rows;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  const cardIds = [];
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) {
      column.cards.push({ ...card, labels: [] });
      cardIds.push(card.id);
    }
  }
  const labelsMap = await getLabelsForCards(cardIds, conn);
  for (const column of columns) {
    for (const card of column.cards) {
      card.labels = labelsMap.get(card.id) || [];
    }
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getCardWithLabels(id, conn = db) {
  const card = await getCard(id, conn);
  if (!card) return null;
  const labelsMap = await getLabelsForCards([id], conn);
  return { ...card, labels: labelsMap.get(id) || [] };
}

async function columnExists(columnId, conn = db) {
  const result = await conn.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

function computeBetween(afterPosition, beforePosition) {
  if (afterPosition == null && beforePosition == null) return POSITION_STEP;
  if (afterPosition == null) return Number(beforePosition) / 2;
  if (beforePosition == null) return Number(afterPosition) + POSITION_STEP;
  return (Number(afterPosition) + Number(beforePosition)) / 2;
}

function positionIsUnsafe(position, afterPosition, beforePosition) {
  if (afterPosition == null && beforePosition == null) return false;
  if (afterPosition == null) return Number(position) >= Number(beforePosition);
  if (beforePosition == null) return Number(position) <= Number(afterPosition);
  return Number(position) <= Number(afterPosition) || Number(position) >= Number(beforePosition);
}

async function renormalizeColumn(conn, columnId, movedCardId, afterId, beforeId) {
  const cardsResult = await conn.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  let cards = cardsResult.rows;
  const movedIndex = cards.findIndex((c) => c.id === movedCardId);
  if (movedIndex === -1) return;

  const afterIndex = afterId ? cards.findIndex((c) => c.id === afterId) : -1;
  const beforeIndex = beforeId ? cards.findIndex((c) => c.id === beforeId) : -1;

  let insertAt = cards.length;
  if (afterIndex !== -1) insertAt = afterIndex + 1;
  else if (beforeIndex !== -1) insertAt = beforeIndex;

  const [moved] = cards.splice(movedIndex, 1);
  if (insertAt > cards.length) insertAt = cards.length;
  cards.splice(insertAt, 0, moved);

  const updates = cards.map((card, index) => ({
    id: card.id,
    position: (index + 1) * POSITION_STEP,
  }));

  for (const u of updates) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [u.position, u.id]);
  }
}

async function createCard(columnId, text, conn = db) {
  if (!(await columnExists(columnId, conn))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const lastCard = await conn.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC, created_at DESC, id DESC LIMIT 1',
    [columnId]
  );
  const lastPos = lastCard.rows[0] ? Number(lastCard.rows[0].position) : 0;
  const position = lastPos + POSITION_STEP;

  await conn.query(
    'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, columnId, text, position, now]
  );
  const card = await getCardWithLabels(id, conn);
  const board = await getBoard(conn);
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId = null, afterId = null) {
  let renormalized = false;
  await db.query('BEGIN');
  try {
    const cardExists = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardExists.rows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }
    if (!(await columnExists(columnId))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    const before = beforeId ? (await db.query('SELECT id, column_id, position FROM cards WHERE id = $1', [beforeId])).rows[0] : null;
    const after = afterId ? (await db.query('SELECT id, column_id, position FROM cards WHERE id = $1', [afterId])).rows[0] : null;

    if (before && before.column_id !== columnId) {
      const err = new Error('beforeId must be in the target column');
      err.status = 400;
      throw err;
    }
    if (after && after.column_id !== columnId) {
      const err = new Error('afterId must be in the target column');
      err.status = 400;
      throw err;
    }

    if (before && after && Number(after.position) >= Number(before.position)) {
      const err = new Error('afterId must come before beforeId in the target column');
      err.status = 400;
      throw err;
    }

    const position = computeBetween(after?.position ?? null, before?.position ?? null);
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, cardId]);

    const collision = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id <> $3 LIMIT 1',
      [columnId, position, cardId]
    );

    if (positionIsUnsafe(position, after?.position ?? null, before?.position ?? null) || collision.rows.length > 0) {
      renormalized = true;
      await renormalizeColumn(db, columnId, cardId, afterId, beforeId);
    }

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  const card = await getCardWithLabels(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'move', card, columnId: card.column_id, renormalized, board });
  return { card, board, renormalized };
}

// Label functions
async function createLabel(name, color) {
  const trimmed = name.trim();
  if (!trimmed) {
    const err = new Error('Label name cannot be empty');
    err.status = 400;
    throw err;
  }
  const id = randomUUID();
  try {
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, trimmed, color]);
  } catch (e) {
    if (e.message.includes('unique')) {
      const err = new Error('Label name must be unique');
      err.status = 409;
      throw err;
    }
    throw e;
  }
  const label = { id, name: trimmed, color };
  const board = await getBoard();
  broadcast('mutation', { type: 'label-create', label, board });
  return { label, board };
}

async function updateLabel(id, name, color) {
  const trimmed = name.trim();
  if (!trimmed) {
    const err = new Error('Label name cannot be empty');
    err.status = 400;
    throw err;
  }
  const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id', [trimmed, color, id]);
  if (result.rows.length === 0) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  const label = { id, name: trimmed, color };
  const board = await getBoard();
  broadcast('mutation', { type: 'label-update', label, board });
  return { label, board };
}

async function deleteLabel(id) {
  const result = await db.query('DELETE FROM labels WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  const board = await getBoard();
  broadcast('mutation', { type: 'label-delete', labelId: id, board });
  return { board };
}

async function assignLabelToCard(cardId, labelId) {
  const card = await getCard(cardId);
  if (!card) {
    const err = new Error('Card not found');
    err.status = 404;
    throw err;
  }
  const labelRes = await db.query('SELECT id FROM labels WHERE id = $1', [labelId]);
  if (labelRes.rows.length === 0) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  try {
    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, labelId]);
  } catch (e) {}
  const updatedCard = await getCardWithLabels(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'label-assign', card: updatedCard, labelId, board });
  return { card: updatedCard, board };
}

async function unassignLabelFromCard(cardId, labelId) {
  await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
  const updatedCard = await getCardWithLabels(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'label-unassign', card: updatedCard, labelId, board });
  return { card: updatedCard, board };
}

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/labels', async (_req, res, next) => {
  try {
    const labels = await getAllLabels();
    res.json({ labels });
  } catch (error) {
    next(error);
  }
});

app.post('/api/labels', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (typeof name !== 'string' || typeof color !== 'string' || !color.match(/^#[0-9a-fA-F]{6}$/)) {
      return res.status(400).json({ error: 'Valid name and hex color (#rrggbb) required' });
    }
    const result = await createLabel(name, color);
    res.status(201).json(result.label);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (typeof name !== 'string' || typeof color !== 'string' || !color.match(/^#[0-9a-fA-F]{6}$/)) {
      return res.status(400).json({ error: 'Valid name and hex color (#rrggbb) required' });
    }
    const result = await updateLabel(req.params.id, name, color);
    res.json(result.label);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const result = await deleteLabel(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId required' });
    const result = await assignLabelToCard(req.params.id, labelId);
    res.json(result.card);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const result = await unassignLabelFromCard(req.params.id, req.params.labelId);
    res.json(result.card);
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    const result = await createCard(columnId, text.trim().slice(0, 500));
    res.status(201).json(result.card);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    const result = await moveCard(req.params.id, columnId, beforeId, afterId);
    res.json(result.card);
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
  sendSse(res, 'connected', { ok: true });

  const heartbeat = setInterval(() => {
    try {
      sendSse(res, 'heartbeat', { now: Date.now() });
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
