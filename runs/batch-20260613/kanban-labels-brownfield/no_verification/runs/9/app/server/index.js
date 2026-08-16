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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function normalizeColor(color) {
  return typeof color === 'string' ? color.trim() : '';
}

function isValidHexColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color);
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
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_label_id ON card_labels(label_id, card_id)');

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

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, id ASC');
  return result.rows;
}

async function hydrateCardsWithLabels(cards, conn = db) {
  for (const card of cards) card.labels = [];
  if (cards.length === 0) return cards;

  const ids = cards.map((card) => card.id);
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
  const labelsResult = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
       FROM card_labels cl
       JOIN labels l ON l.id = cl.label_id
      WHERE cl.card_id IN (${placeholders})
      ORDER BY lower(l.name) ASC, l.id ASC`,
    ids
  );
  const byCard = new Map(cards.map((card) => [card.id, card]));
  for (const row of labelsResult.rows) {
    const card = byCard.get(row.card_id);
    if (card) card.labels.push({ id: row.id, name: row.name, color: row.color });
  }
  return cards;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );

  const cards = await hydrateCardsWithLabels(cardsResult.rows, conn);
  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cards) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (!card) return null;
  await hydrateCardsWithLabels([card], conn);
  return card;
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
  if (afterPosition != null && position <= Number(afterPosition)) return true;
  if (beforePosition != null && position >= Number(beforePosition)) return true;
  return false;
}

async function getNeighborCard(id, columnId, movedCardId, paramName, conn = db) {
  if (id == null) return null;
  const card = await getCard(id, conn);
  if (!card || card.id === movedCardId || card.column_id !== columnId) {
    throw httpError(400, `${paramName} must be a card in the target column`);
  }
  return card;
}

async function renormalizeColumn(conn, columnId, movedCardId = null, afterId = null, beforeId = null) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  let ids = result.rows.map((row) => row.id);

  if (movedCardId && ids.includes(movedCardId)) {
    ids = ids.filter((id) => id !== movedCardId);
    let insertAt = ids.length;
    if (afterId) {
      const index = ids.indexOf(afterId);
      if (index !== -1) insertAt = index + 1;
    } else if (beforeId) {
      const index = ids.indexOf(beforeId);
      if (index !== -1) insertAt = index;
    }
    ids.splice(insertAt, 0, movedCardId);
  }

  for (let index = 0; index < ids.length; index += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, ids[index]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) throw httpError(400, 'columnId does not exist');

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

  const saved = await getCard(card.id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card: saved, columnId, board });
  return { card: saved, board };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  let renormalized = false;

  await db.query('BEGIN');
  try {
    if (!(await columnExists(columnId, db))) throw httpError(400, 'columnId does not exist');
    const existing = await getCard(cardId, db);
    if (!existing) throw httpError(404, 'Card not found');

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

async function ensureUniqueLabelName(name, excludeId = null) {
  const result = await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) AND ($2::text IS NULL OR id <> $2) LIMIT 1', [
    name,
    excludeId,
  ]);
  if (result.rows.length > 0) throw httpError(409, 'Label name already exists');
}

async function getLabel(id, conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  return result.rows[0] || null;
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
    const name = normalizeName(req.body?.name);
    const color = normalizeColor(req.body?.color);
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    if (!isValidHexColor(color)) return res.status(400).json({ error: 'Label color must be a hex value like #2563eb' });
    await ensureUniqueLabelName(name);

    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name, color]);
    const label = await getLabel(id);
    await broadcastLabelMutation('label-create', { label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const existing = await getLabel(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Label not found' });

    const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
    const hasColor = Object.prototype.hasOwnProperty.call(req.body || {}, 'color');
    const name = hasName ? normalizeName(req.body.name) : existing.name;
    const color = hasColor ? normalizeColor(req.body.color) : existing.color;

    if (!name) return res.status(400).json({ error: 'Label name is required' });
    if (!isValidHexColor(color)) return res.status(400).json({ error: 'Label color must be a hex value like #2563eb' });
    await ensureUniqueLabelName(name, req.params.id);

    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [name, color, req.params.id]);
    const label = await getLabel(req.params.id);
    await broadcastLabelMutation('label-update', { label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const label = await getLabel(req.params.id);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    await db.query('DELETE FROM card_labels WHERE label_id = $1', [req.params.id]);
    await db.query('DELETE FROM labels WHERE id = $1', [req.params.id]);
    await broadcastLabelMutation('label-delete', { label });
    res.json({ ok: true, label });
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
    const card = await getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const label = await getLabel(labelId);
    if (!label) return res.status(404).json({ error: 'Label not found' });

    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const updatedCard = await getCard(req.params.id);
    await broadcastLabelMutation('label-assign', { card: updatedCard, label });
    res.status(201).json(updatedCard);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const card = await getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const label = await getLabel(req.params.labelId);
    if (!label) return res.status(404).json({ error: 'Label not found' });

    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const updatedCard = await getCard(req.params.id);
    await broadcastLabelMutation('label-unassign', { card: updatedCard, label });
    res.json(updatedCard);
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
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'A record with that unique value already exists' });
  }
  if (err?.code === '23514') {
    return res.status(400).json({ error: err.message || 'Invalid value' });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
