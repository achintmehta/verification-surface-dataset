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
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function normalizeColor(color) {
  return typeof color === 'string' ? color.trim() : '';
}

function assertValidLabelInput(name, color, partial = false) {
  const out = {};
  if (!partial || name !== undefined) {
    out.name = normalizeName(name);
    if (!out.name) throw httpError(400, 'Label name is required');
  }
  if (!partial || color !== undefined) {
    out.color = normalizeColor(color);
    if (!HEX_COLOR_RE.test(out.color)) throw httpError(400, 'Label color must be a hex value');
  }
  return out;
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
      color TEXT NOT NULL CHECK (color ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$')
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_card_id ON card_labels(card_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_label_id ON card_labels(label_id)');

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

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
}

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, name ASC, id ASC');
  return result.rows;
}

async function getLabelsForCards(conn = db) {
  const result = await conn.query(`
    SELECT cl.card_id, l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC
  `);
  const byCard = new Map();
  for (const row of result.rows) {
    if (!byCard.has(row.card_id)) byCard.set(row.card_id, []);
    byCard.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }
  return byCard;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labelsByCard = await getLabelsForCards(conn);
  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const rawCard of cardsResult.rows) {
    const card = { ...rawCard, labels: labelsByCard.get(rawCard.id) || [] };
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
  for (const column of columns) column.cards.sort(compareCards);
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (!card) return null;
  const labels = await conn.query(`
    SELECT l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON l.id = cl.label_id
    WHERE cl.card_id = $1
    ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC
  `, [id]);
  return { ...card, labels: labels.rows };
}

async function columnExists(columnId, conn = db) {
  const result = await conn.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function cardExists(cardId, conn = db) {
  const result = await conn.query('SELECT id FROM cards WHERE id = $1', [cardId]);
  return result.rows.length > 0;
}

async function labelExists(labelId, conn = db) {
  const result = await conn.query('SELECT id FROM labels WHERE id = $1', [labelId]);
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
  if (afterPosition != null && !(Number(position) > Number(afterPosition))) return true;
  if (beforePosition != null && !(Number(position) < Number(beforePosition))) return true;
  if (afterPosition != null && Math.abs(Number(position) - Number(afterPosition)) < 1e-9) return true;
  if (beforePosition != null && Math.abs(Number(beforePosition) - Number(position)) < 1e-9) return true;
  return false;
}

async function getNeighborCard(id, columnId, movingCardId, fieldName, conn = db) {
  if (id == null) return null;
  if (id === movingCardId) throw httpError(400, `${fieldName} cannot be the moved card`);
  const result = await conn.query('SELECT id, column_id, position FROM cards WHERE id = $1', [id]);
  const card = result.rows[0];
  if (!card) throw httpError(400, `${fieldName} was not found`);
  if (card.column_id !== columnId) throw httpError(400, `${fieldName} must be in the target column`);
  return card;
}

async function renormalizeColumn(conn, columnId, movingCardId = null, afterId = null, beforeId = null) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  let ids = result.rows.map((row) => row.id);
  if (movingCardId) {
    ids = ids.filter((id) => id !== movingCardId);
    let insertAt = ids.length;
    if (afterId) {
      const afterIndex = ids.indexOf(afterId);
      if (afterIndex !== -1) insertAt = afterIndex + 1;
    } else if (beforeId) {
      const beforeIndex = ids.indexOf(beforeId);
      if (beforeIndex !== -1) insertAt = beforeIndex;
    }
    ids.splice(insertAt, 0, movingCardId);
  }
  let position = POSITION_STEP;
  for (const id of ids) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
    position += POSITION_STEP;
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) throw httpError(404, 'Column not found');
  const maxResult = await db.query('SELECT MAX(position)::float AS max FROM cards WHERE column_id = $1', [columnId]);
  const position = maxResult.rows[0].max == null ? POSITION_STEP : Number(maxResult.rows[0].max) + POSITION_STEP;
  const cardId = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
    [cardId, columnId, text, position, createdAt]
  );
  const card = await getCard(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId = null, afterId = null) {
  if (!(await cardExists(cardId))) throw httpError(404, 'Card not found');
  if (!(await columnExists(columnId))) throw httpError(404, 'Column not found');
  let renormalized = false;

  await db.query('BEGIN');
  try {
    const before = await getNeighborCard(beforeId, columnId, cardId, 'beforeId', db);
    const after = await getNeighborCard(afterId, columnId, cardId, 'afterId', db);
    if (before && after && Number(after.position) >= Number(before.position)) {
      throw httpError(400, 'afterId must come before beforeId in the target column');
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

async function broadcastLabelMutation(type, data = {}) {
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type, ...data, board, labels });
  return { board, labels };
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
    res.json(await getLabels());
  } catch (error) {
    next(error);
  }
});

app.post('/api/labels', async (req, res, next) => {
  try {
    const { name, color } = assertValidLabelInput(req.body?.name, req.body?.color);
    const id = randomUUID();
    try {
      await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name, color]);
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('duplicate') || String(error.message || '').toLowerCase().includes('unique')) {
        throw httpError(409, 'Label name already exists');
      }
      throw error;
    }
    const result = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
    const label = result.rows[0];
    await broadcastLabelMutation('label:create', { label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const patch = assertValidLabelInput(req.body?.name, req.body?.color, true);
    if (patch.name === undefined && patch.color === undefined) throw httpError(400, 'At least one of name or color is required');
    const existing = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) throw httpError(404, 'Label not found');
    const nextName = patch.name ?? existing.rows[0].name;
    const nextColor = patch.color ?? existing.rows[0].color;
    try {
      await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [nextName, nextColor, req.params.id]);
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('duplicate') || String(error.message || '').toLowerCase().includes('unique')) {
        throw httpError(409, 'Label name already exists');
      }
      throw error;
    }
    const updated = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    const label = updated.rows[0];
    await broadcastLabelMutation('label:update', { label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const existing = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) throw httpError(404, 'Label not found');
    const label = existing.rows[0];
    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM card_labels WHERE label_id = $1', [req.params.id]);
      await db.query('DELETE FROM labels WHERE id = $1', [req.params.id]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    await broadcastLabelMutation('label:delete', { labelId: req.params.id, label });
    res.status(204).end();
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

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) throw httpError(400, 'labelId is required');
    if (!(await cardExists(req.params.id))) throw httpError(404, 'Card not found');
    if (!(await labelExists(labelId))) throw httpError(404, 'Label not found');
    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label:assign', { card, cardId: req.params.id, labelId });
    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    if (!(await cardExists(req.params.id))) throw httpError(404, 'Card not found');
    if (!(await labelExists(req.params.labelId))) throw httpError(404, 'Label not found');
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label:unassign', { card, cardId: req.params.id, labelId: req.params.labelId });
    res.json(card);
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
