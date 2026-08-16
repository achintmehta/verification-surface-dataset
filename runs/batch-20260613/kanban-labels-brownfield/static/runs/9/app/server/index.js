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
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

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

  // Additive label migration. These tables do not alter or rewrite existing columns/cards.
  await db.query(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
    )
  `);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_lower_name ON labels (lower(name))');
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    )
  `);
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

function normalizeLabelInput(body, current = null) {
  const hasName = Object.prototype.hasOwnProperty.call(body || {}, 'name');
  const hasColor = Object.prototype.hasOwnProperty.call(body || {}, 'color');
  const name = hasName ? String(body.name ?? '').trim().slice(0, 80) : current?.name;
  const color = hasColor ? String(body.color ?? '').trim() : current?.color;

  if (!name) {
    const err = new Error('Label name is required');
    err.status = 400;
    throw err;
  }
  if (!HEX_COLOR_RE.test(color || '')) {
    const err = new Error('Label color must be a hex value like #2563eb');
    err.status = 400;
    throw err;
  }
  return { name, color };
}

function isDuplicateError(error) {
  return error?.code === '23505' || /duplicate|unique/i.test(error?.message || '');
}

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, id ASC');
  return result.rows;
}

async function getLabel(id, conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getCardLabels(cardIds, conn = db) {
  if (cardIds.length === 0) return new Map();
  const placeholders = cardIds.map((_, index) => `$${index + 1}`).join(', ');
  const result = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
     FROM card_labels cl
     JOIN labels l ON l.id = cl.label_id
     WHERE cl.card_id IN (${placeholders})
     ORDER BY lower(l.name) ASC, l.id ASC`,
    cardIds
  );
  const byCard = new Map(cardIds.map((id) => [id, []]));
  for (const row of result.rows) {
    byCard.get(row.card_id)?.push({ id: row.id, name: row.name, color: row.color });
  }
  return byCard;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labelsByCard = await getCardLabels(cardsResult.rows.map((card) => card.id), conn);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push({ ...card, labels: labelsByCard.get(card.id) || [] });
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (!card) return null;
  const labelsByCard = await getCardLabels([card.id], conn);
  return { ...card, labels: labelsByCard.get(card.id) || [] };
}

async function columnExists(columnId, conn = db) {
  const result = await conn.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function cardExists(cardId, conn = db) {
  const result = await conn.query('SELECT id FROM cards WHERE id = $1', [cardId]);
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
  if (afterPosition != null && position <= Number(afterPosition)) return true;
  if (beforePosition != null && position >= Number(beforePosition)) return true;
  return false;
}

async function getNeighbor(id, columnId, movingCardId, name, conn = db) {
  if (id == null) return null;
  if (id === movingCardId) {
    const err = new Error(`${name} cannot be the moving card`);
    err.status = 400;
    throw err;
  }
  const result = await conn.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [id, columnId]);
  const card = result.rows[0];
  if (!card) {
    const err = new Error(`${name} must be a card in the target column`);
    err.status = 400;
    throw err;
  }
  return card;
}

async function renormalizeColumn(conn, columnId, movingCardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  const ids = result.rows.map((row) => row.id).filter((id) => id !== movingCardId);
  let insertAt = ids.length;
  if (afterId) {
    const index = ids.indexOf(afterId);
    if (index !== -1) insertAt = index + 1;
  } else if (beforeId) {
    const index = ids.indexOf(beforeId);
    if (index !== -1) insertAt = index;
  }
  ids.splice(insertAt, 0, movingCardId);
  for (let index = 0; index < ids.length; index += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, ids[index]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }
  const positionResult = await db.query('SELECT COALESCE(MAX(position), 0) + $1 AS position FROM cards WHERE column_id = $2', [
    POSITION_STEP,
    columnId,
  ]);
  const card = {
    id: randomUUID(),
    column_id: columnId,
    text,
    position: Number(positionResult.rows[0].position),
    created_at: new Date().toISOString(),
  };
  await db.query('INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)', [
    card.id,
    card.column_id,
    card.text,
    card.position,
    card.created_at,
  ]);
  const savedCard = await getCard(card.id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card: savedCard, columnId, board });
  return { card: savedCard, board };
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

    const before = await getNeighbor(beforeId, columnId, cardId, 'beforeId', db);
    const after = await getNeighbor(afterId, columnId, cardId, 'afterId', db);
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
    const labelInput = normalizeLabelInput(req.body);
    const existing = await db.query('SELECT id FROM labels WHERE lower(name) = lower($1)', [labelInput.name]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Label name already exists' });

    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, labelInput.name, labelInput.color]);
    const label = await getLabel(id);
    await broadcastLabelMutation('label:create', { label });
    res.status(201).json(label);
  } catch (error) {
    if (isDuplicateError(error)) return res.status(409).json({ error: 'Label name already exists' });
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const current = await getLabel(req.params.id);
    if (!current) return res.status(404).json({ error: 'Label not found' });
    const labelInput = normalizeLabelInput(req.body, current);
    const existing = await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) AND id <> $2', [
      labelInput.name,
      req.params.id,
    ]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Label name already exists' });

    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [labelInput.name, labelInput.color, req.params.id]);
    const label = await getLabel(req.params.id);
    await broadcastLabelMutation('label:update', { label });
    res.json(label);
  } catch (error) {
    if (isDuplicateError(error)) return res.status(409).json({ error: 'Label name already exists' });
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const label = await getLabel(req.params.id);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    await db.query('DELETE FROM labels WHERE id = $1', [req.params.id]);
    await broadcastLabelMutation('label:delete', { labelId: req.params.id });
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
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    if (!(await cardExists(req.params.id))) return res.status(404).json({ error: 'Card not found' });
    if (!(await getLabel(labelId))) return res.status(404).json({ error: 'Label not found' });

    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label:assign', { card, labelId });
    res.json(card);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    if (!(await cardExists(req.params.id))) return res.status(404).json({ error: 'Card not found' });
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label:unassign', { card, labelId: req.params.labelId });
    res.status(204).end();
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
