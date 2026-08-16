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

function normalizeLabelName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function normalizeColor(color) {
  if (typeof color !== 'string') return '';
  const trimmed = color.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed.toUpperCase() : '';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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
      color TEXT NOT NULL
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

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY name ASC, id ASC');
  return result.rows;
}

async function labelNameExists(name, excludeId = null, conn = db) {
  const result = excludeId
    ? await conn.query('SELECT id FROM labels WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1', [name, excludeId])
    : await conn.query('SELECT id FROM labels WHERE lower(name) = lower($1) LIMIT 1', [name]);
  return result.rows.length > 0;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labels = await getLabels(conn);
  const labelOrder = new Map(labels.map((label, index) => [label.id, index]));
  const labelsResult = await conn.query(`
    SELECT cl.card_id, l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON l.id = cl.label_id
  `);

  const labelsByCard = new Map();
  for (const row of labelsResult.rows) {
    const list = labelsByCard.get(row.card_id) || [];
    list.push({ id: row.id, name: row.name, color: row.color });
    labelsByCard.set(row.card_id, list);
  }
  for (const list of labelsByCard.values()) {
    list.sort((a, b) => (labelOrder.get(a.id) ?? 0) - (labelOrder.get(b.id) ?? 0) || a.id.localeCompare(b.id));
  }

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push({ ...card, labels: labelsByCard.get(card.id) || [] });
  }
  return { columns, labels };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (!card) return null;
  const allLabels = await getLabels(conn);
  const labelOrder = new Map(allLabels.map((label, index) => [label.id, index]));
  const labels = await conn.query(
    `SELECT l.id, l.name, l.color
     FROM card_labels cl JOIN labels l ON l.id = cl.label_id
     WHERE cl.card_id = $1`,
    [id]
  );
  return {
    ...card,
    labels: labels.rows.sort((a, b) => (labelOrder.get(a.id) ?? 0) - (labelOrder.get(b.id) ?? 0) || a.id.localeCompare(b.id)),
  };
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
  return Math.abs(position) > Number.MAX_SAFE_INTEGER / 2;
}

async function getNeighbor(cardId, columnId, fieldName, conn = db) {
  if (cardId == null) return null;
  const result = await conn.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [cardId, columnId]);
  if (result.rows.length === 0) throw httpError(400, `${fieldName} must reference a card in the target column`);
  return result.rows[0];
}

async function renormalizeColumn(conn, columnId, movedCardId = null, afterId = null, beforeId = null) {
  const result = await conn.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC', [columnId]);
  let ids = result.rows.map((row) => row.id).filter((id) => id !== movedCardId);

  if (movedCardId) {
    let insertAt = ids.length;
    if (afterId) {
      const afterIndex = ids.indexOf(afterId);
      if (afterIndex !== -1) insertAt = afterIndex + 1;
    } else if (beforeId) {
      const beforeIndex = ids.indexOf(beforeId);
      if (beforeIndex !== -1) insertAt = beforeIndex;
    }
    ids.splice(insertAt, 0, movedCardId);
  }

  for (let index = 0; index < ids.length; index += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, ids[index]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) throw httpError(404, 'Column not found');
  const last = await db.query('SELECT MAX(position) AS position FROM cards WHERE column_id = $1', [columnId]);
  const position = last.rows[0].position == null ? POSITION_STEP : Number(last.rows[0].position) + POSITION_STEP;
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
  let renormalized = false;
  await db.query('BEGIN');
  try {
    if (!(await columnExists(columnId, db))) throw httpError(404, 'Column not found');

    const existing = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (existing.rows.length === 0) throw httpError(404, 'Card not found');

    if (beforeId && beforeId === cardId) beforeId = null;
    if (afterId && afterId === cardId) afterId = null;
    if (beforeId && afterId && beforeId === afterId) throw httpError(400, 'beforeId and afterId must be different');

    const before = await getNeighbor(beforeId, columnId, 'beforeId', db);
    const after = await getNeighbor(afterId, columnId, 'afterId', db);

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

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key|unique/i.test(error?.message || '');
}

async function broadcastLabelMutation(type, extra = {}) {
  const board = await getBoard();
  broadcast('mutation', { type, ...extra, labels: board.labels, board });
  return board;
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
    const name = normalizeLabelName(req.body?.name);
    const color = normalizeColor(req.body?.color);
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    if (!color) return res.status(400).json({ error: 'Valid hex color is required' });
    if (await labelNameExists(name)) return res.status(409).json({ error: 'Label name must be unique' });

    const label = { id: randomUUID(), name, color };
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [label.id, label.name, label.color]);
    await broadcastLabelMutation('label:create', { label });
    res.status(201).json(label);
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'Label name must be unique' });
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const name = normalizeLabelName(req.body?.name);
    const color = normalizeColor(req.body?.color);
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    if (!color) return res.status(400).json({ error: 'Valid hex color is required' });
    if (await labelNameExists(name, req.params.id)) return res.status(409).json({ error: 'Label name must be unique' });

    const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color', [
      name,
      color,
      req.params.id,
    ]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    const label = result.rows[0];
    await broadcastLabelMutation('label:update', { label });
    res.json(label);
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'Label name must be unique' });
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const existing = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    await db.query('DELETE FROM card_labels WHERE label_id = $1', [req.params.id]);
    const result = await db.query('DELETE FROM labels WHERE id = $1 RETURNING id, name, color', [req.params.id]);
    await broadcastLabelMutation('label:delete', { label: result.rows[0] });
    res.json({ ok: true });
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

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    if (!(await getCard(req.params.id))) return res.status(404).json({ error: 'Card not found' });
    const label = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [labelId]);
    if (label.rows.length === 0) return res.status(404).json({ error: 'Label not found' });

    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label:assign', { card, label: label.rows[0] });
    res.json(card);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    await broadcastLabelMutation('label:unassign', { card, labelId: req.params.labelId });
    res.json(card);
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
