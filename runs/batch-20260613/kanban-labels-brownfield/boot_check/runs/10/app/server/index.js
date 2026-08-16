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
const MAX_POSITION_GAP = 1e-7;

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
      color TEXT NOT NULL CHECK (color ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    )
  `);
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

function compareLabels(a, b) {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, id ASC');
  return result.rows;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labelsResult = await conn.query(`
    SELECT cl.card_id, l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY lower(l.name) ASC, l.id ASC
  `);

  const labelsByCard = new Map();
  for (const row of labelsResult.rows) {
    if (!labelsByCard.has(row.card_id)) labelsByCard.set(row.card_id, []);
    labelsByCard.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }

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
  const labels = await conn.query(
    `SELECT l.id, l.name, l.color
     FROM card_labels cl
     JOIN labels l ON l.id = cl.label_id
     WHERE cl.card_id = $1
     ORDER BY lower(l.name) ASC, l.id ASC`,
    [id]
  );
  return { ...card, labels: labels.rows };
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
  if (afterPosition != null && Math.abs(position - Number(afterPosition)) < MAX_POSITION_GAP) return true;
  if (beforePosition != null && Math.abs(Number(beforePosition) - position) < MAX_POSITION_GAP) return true;
  return false;
}

async function getNeighbor(cardId, columnId, label, conn = db) {
  if (cardId == null) return null;
  const result = await conn.query('SELECT id, column_id, position FROM cards WHERE id = $1', [cardId]);
  const card = result.rows[0];
  if (!card) {
    const err = new Error(`${label} does not exist`);
    err.status = 400;
    throw err;
  }
  if (card.column_id !== columnId) {
    const err = new Error(`${label} is not in the target column`);
    err.status = 400;
    throw err;
  }
  return card;
}

async function renormalizeColumn(conn, columnId, movedCardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  let cards = result.rows.filter((card) => card.id !== movedCardId);
  const moved = result.rows.find((card) => card.id === movedCardId);
  if (!moved) return;

  let insertAt = cards.length;
  if (afterId) {
    const index = cards.findIndex((card) => card.id === afterId);
    insertAt = index === -1 ? cards.length : index + 1;
  } else if (beforeId) {
    const index = cards.findIndex((card) => card.id === beforeId);
    insertAt = index === -1 ? cards.length : index;
  }
  cards.splice(insertAt, 0, moved);

  for (let index = 0; index < cards.length; index += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, cards[index].id]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error('columnId does not exist');
    err.status = 400;
    throw err;
  }

  const last = await db.query('SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC LIMIT 1', [columnId]);
  const position = last.rows.length > 0 ? Number(last.rows[0].position) + POSITION_STEP : POSITION_STEP;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
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
  if (!(await columnExists(columnId))) {
    const err = new Error('columnId does not exist');
    err.status = 400;
    throw err;
  }

  let renormalized = false;
  await db.query('BEGIN');
  try {
    const existing = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (existing.rows.length === 0) {
      const err = new Error('card does not exist');
      err.status = 404;
      throw err;
    }

    const before = await getNeighbor(beforeId, columnId, 'beforeId', db);
    const after = await getNeighbor(afterId, columnId, 'afterId', db);

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

function normalizeLabelInput(body, existing = {}) {
  const nextName = body?.name == null ? existing.name : String(body.name).trim();
  const nextColor = body?.color == null ? existing.color : String(body.color).trim();
  if (!nextName) {
    const err = new Error('label name is required');
    err.status = 400;
    throw err;
  }
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(nextColor || '')) {
    const err = new Error('label color must be a valid hex value');
    err.status = 400;
    throw err;
  }
  return { name: nextName.slice(0, 80), color: nextColor.toLowerCase() };
}

async function labelNameTaken(name, exceptId = null) {
  const result = await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) AND ($2::text IS NULL OR id <> $2)', [name, exceptId]);
  return result.rows.length > 0;
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
    const label = normalizeLabelInput(req.body || {});
    if (await labelNameTaken(label.name)) return res.status(409).json({ error: 'label name already exists' });
    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, label.name, label.color]);
    const created = { id, ...label };
    await broadcastLabelMutation('label-create', { label: created });
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const currentResult = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ error: 'label does not exist' });
    const nextLabel = normalizeLabelInput(req.body || {}, current);
    if (await labelNameTaken(nextLabel.name, req.params.id)) return res.status(409).json({ error: 'label name already exists' });
    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [nextLabel.name, nextLabel.color, req.params.id]);
    const updated = { id: req.params.id, ...nextLabel };
    await broadcastLabelMutation('label-update', { label: updated });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const current = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'label does not exist' });
    await db.query('DELETE FROM card_labels WHERE label_id = $1', [req.params.id]);
    await db.query('DELETE FROM labels WHERE id = $1', [req.params.id]);
    await broadcastLabelMutation('label-delete', { label: current.rows[0], labelId: req.params.id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    const cardExists = await db.query('SELECT id FROM cards WHERE id = $1', [req.params.id]);
    if (cardExists.rows.length === 0) return res.status(404).json({ error: 'card does not exist' });
    const labelExists = await db.query('SELECT id FROM labels WHERE id = $1', [labelId]);
    if (labelExists.rows.length === 0) return res.status(404).json({ error: 'label does not exist' });
    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label-assign', { card, cardId: req.params.id, labelId });
    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const cardExists = await db.query('SELECT id FROM cards WHERE id = $1', [req.params.id]);
    if (cardExists.rows.length === 0) return res.status(404).json({ error: 'card does not exist' });
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label-unassign', { card, cardId: req.params.id, labelId: req.params.labelId });
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
