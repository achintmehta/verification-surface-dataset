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
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      CHECK (length(trim(name)) > 0),
      CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_card ON card_labels(card_id, label_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_label ON card_labels(label_id, card_id)');

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

function normalizeName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function normalizeColor(color) {
  if (typeof color !== 'string') return null;
  let value = color.trim();
  if (/^[0-9A-Fa-f]{3}$/.test(value)) value = `#${value}`;
  if (/^#[0-9A-Fa-f]{3}$/.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  } else if (/^[0-9A-Fa-f]{6}$/.test(value)) {
    value = `#${value}`;
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return null;
  return value.toUpperCase();
}

function isUniqueViolation(error) {
  return error?.code === '23505' || String(error?.message || '').toLowerCase().includes('duplicate');
}

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, id ASC');
  return result.rows;
}

async function labelsByCardIds(cardIds, conn = db) {
  const map = new Map(cardIds.map((id) => [id, []]));
  if (cardIds.length === 0) return map;
  const result = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
       FROM card_labels cl
       JOIN labels l ON l.id = cl.label_id
      ORDER BY cl.card_id ASC, lower(l.name) ASC, l.id ASC`
  );
  for (const row of result.rows) {
    const labels = map.get(row.card_id);
    if (labels) labels.push({ id: row.id, name: row.name, color: row.color });
  }
  return map;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labelMap = await labelsByCardIds(cardsResult.rows.map((card) => card.id), conn);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push({ ...card, labels: labelMap.get(card.id) || [] });
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (!card) return null;
  const labelMap = await labelsByCardIds([card.id], conn);
  return { ...card, labels: labelMap.get(card.id) || [] };
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
  if (!Number.isFinite(position)) return true;
  if (afterPosition != null && !(position > Number(afterPosition))) return true;
  if (beforePosition != null && !(position < Number(beforePosition))) return true;
  return Math.abs(position) > Number.MAX_SAFE_INTEGER / 2;
}

async function getNeighbor(columnId, neighborId, movingCardId, name, conn = db) {
  if (neighborId == null) return null;
  const result = await conn.query('SELECT id, column_id, position FROM cards WHERE id = $1', [neighborId]);
  const card = result.rows[0];
  if (!card || card.id === movingCardId || card.column_id !== columnId) {
    const err = new Error(`${name} must be an existing card in the target column`);
    err.status = 400;
    throw err;
  }
  return card;
}

async function renormalizeColumn(conn, columnId, movingCardId = null, afterId = null, beforeId = null) {
  const result = await conn.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC', [columnId]);
  let ids = result.rows.map((row) => row.id).filter((id) => id !== movingCardId);

  if (movingCardId) {
    let index = ids.length;
    if (afterId) {
      const afterIndex = ids.indexOf(afterId);
      if (afterIndex !== -1) index = afterIndex + 1;
    } else if (beforeId) {
      const beforeIndex = ids.indexOf(beforeId);
      if (beforeIndex !== -1) index = beforeIndex;
    }
    ids.splice(index, 0, movingCardId);
  }

  for (let i = 0; i < ids.length; i += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, ids[i]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const max = await db.query('SELECT MAX(position)::float8 AS max FROM cards WHERE column_id = $1', [columnId]);
  const position = (Number(max.rows[0].max) || 0) + POSITION_STEP;
  await db.query('INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)', [
    id,
    columnId,
    text,
    position,
    createdAt,
  ]);

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId = null, afterId = null) {
  let renormalized = false;

  await db.query('BEGIN');
  try {
    const existing = await getCard(cardId, db);
    if (!existing) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }
    if (!(await columnExists(columnId, db))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    const before = await getNeighbor(columnId, beforeId, cardId, 'beforeId', db);
    const after = await getNeighbor(columnId, afterId, cardId, 'afterId', db);

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

  const card = await getCard(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'move', card, columnId: card.column_id, renormalized, board });
  return { card, board, renormalized };
}

async function broadcastLabelMutation(type, extra = {}) {
  const [labels, board] = await Promise.all([getLabels(), getBoard()]);
  broadcast('mutation', { type, labels, board, ...extra });
  return { labels, board };
}

async function createLabel(nameInput, colorInput) {
  const name = normalizeName(nameInput);
  const color = normalizeColor(colorInput);
  if (!name) {
    const err = new Error('Label name is required');
    err.status = 400;
    throw err;
  }
  if (!color) {
    const err = new Error('Label color must be a valid hex value');
    err.status = 400;
    throw err;
  }

  const id = randomUUID();
  try {
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name, color]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      error.status = 409;
      error.message = 'Label name already exists';
    }
    throw error;
  }
  const label = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id])).rows[0];
  await broadcastLabelMutation('label:create', { label });
  return label;
}

async function updateLabel(id, body = {}) {
  const existing = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id])).rows[0];
  if (!existing) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }

  const name = Object.prototype.hasOwnProperty.call(body, 'name') ? normalizeName(body.name) : existing.name;
  const color = Object.prototype.hasOwnProperty.call(body, 'color') ? normalizeColor(body.color) : existing.color;
  if (!name) {
    const err = new Error('Label name is required');
    err.status = 400;
    throw err;
  }
  if (!color) {
    const err = new Error('Label color must be a valid hex value');
    err.status = 400;
    throw err;
  }

  try {
    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [name, color, id]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      error.status = 409;
      error.message = 'Label name already exists';
    }
    throw error;
  }
  const label = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id])).rows[0];
  await broadcastLabelMutation('label:update', { label });
  return label;
}

async function deleteLabel(id) {
  const existing = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id])).rows[0];
  if (!existing) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  await db.query('DELETE FROM labels WHERE id = $1', [id]);
  await broadcastLabelMutation('label:delete', { label: existing, labelId: id });
}

async function assignLabel(cardId, labelId) {
  const card = await getCard(cardId);
  if (!card) {
    const err = new Error('Card not found');
    err.status = 404;
    throw err;
  }
  const label = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [labelId])).rows[0];
  if (!label) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, labelId]);
  const updatedCard = await getCard(cardId);
  await broadcastLabelMutation('label:assign', { card: updatedCard, label });
  return updatedCard;
}

async function unassignLabel(cardId, labelId) {
  const card = await getCard(cardId);
  if (!card) {
    const err = new Error('Card not found');
    err.status = 404;
    throw err;
  }
  await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
  const updatedCard = await getCard(cardId);
  await broadcastLabelMutation('label:unassign', { card: updatedCard, labelId });
  return updatedCard;
}

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

app.get('/api/labels', async (_req, res, next) => {
  try {
    res.json(await getLabels());
  } catch (error) {
    next(error);
  }
});

app.post('/api/labels', async (req, res, next) => {
  try {
    const label = await createLabel(req.body?.name, req.body?.color);
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    res.json(await updateLabel(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    await deleteLabel(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    res.json(await assignLabel(req.params.id, labelId));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    res.json(await unassignLabel(req.params.id, req.params.labelId));
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
