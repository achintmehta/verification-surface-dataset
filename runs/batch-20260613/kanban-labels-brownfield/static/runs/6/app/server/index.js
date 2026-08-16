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
      name TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),
      color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
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

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, name ASC, id ASC');
  return result.rows;
}

async function getLabel(id, conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labelResult = await conn.query(`
    SELECT cl.card_id, l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC
  `);

  const labelsByCard = new Map();
  for (const row of labelResult.rows) {
    const labels = labelsByCard.get(row.card_id) || [];
    labels.push({ id: row.id, name: row.name, color: row.color });
    labelsByCard.set(row.card_id, labels);
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
     ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC`,
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
  if (afterPosition != null && position <= Number(afterPosition)) return true;
  if (beforePosition != null && position >= Number(beforePosition)) return true;
  if (afterPosition != null && Math.abs(position - Number(afterPosition)) < 0.000001) return true;
  if (beforePosition != null && Math.abs(Number(beforePosition) - position) < 0.000001) return true;
  return false;
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const maxResult = await db.query('SELECT COALESCE(MAX(position), 0) + $2 AS position FROM cards WHERE column_id = $1', [
    columnId,
    POSITION_STEP,
  ]);
  await db.query('INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)', [
    id,
    columnId,
    text,
    Number(maxResult.rows[0].position),
    createdAt,
  ]);
  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function getNeighbor(cardId, columnId, field, conn = db) {
  if (cardId == null) return null;
  const card = await getCard(cardId, conn);
  if (!card) {
    const err = new Error(`${field} card not found`);
    err.status = 400;
    throw err;
  }
  if (card.column_id !== columnId) {
    const err = new Error(`${field} must be in the target column`);
    err.status = 400;
    throw err;
  }
  return card;
}

async function renormalizeColumn(conn, columnId, movingCardId, afterId, beforeId) {
  const result = await conn.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC', [columnId]);
  const ids = result.rows.map((row) => row.id).filter((id) => id !== movingCardId);
  let insertAt = ids.length;
  if (afterId) {
    const afterIndex = ids.indexOf(afterId);
    if (afterIndex !== -1) insertAt = afterIndex + 1;
  } else if (beforeId) {
    const beforeIndex = ids.indexOf(beforeId);
    if (beforeIndex !== -1) insertAt = beforeIndex;
  }
  ids.splice(insertAt, 0, movingCardId);
  for (let index = 0; index < ids.length; index += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, ids[index]]);
  }
}

async function moveCard(cardId, columnId, beforeId = null, afterId = null) {
  if (beforeId === cardId || afterId === cardId) {
    const err = new Error('A card cannot be moved relative to itself');
    err.status = 400;
    throw err;
  }
  let renormalized = false;
  await db.query('BEGIN');
  try {
    const card = await getCard(cardId, db);
    if (!card) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }
    if (!(await columnExists(columnId, db))) {
      const err = new Error('Column not found');
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

function normalizeLabelName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function normalizeColor(color) {
  if (typeof color !== 'string') return '';
  const trimmed = color.trim();
  const shortMatch = trimmed.match(/^#([0-9a-fA-F]{3})$/);
  if (shortMatch) return `#${shortMatch[1].split('').map((char) => char + char).join('')}`.toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return '';
}

async function assertUniqueLabelName(name, exceptId = null) {
  const result = exceptId
    ? await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1', [name, exceptId])
    : await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) LIMIT 1', [name]);
  if (result.rows.length > 0) {
    const err = new Error('Label name already exists');
    err.status = 409;
    throw err;
  }
}

async function createLabel(nameInput, colorInput) {
  const name = normalizeLabelName(nameInput);
  const color = normalizeColor(colorInput);
  if (!name || !color) {
    const err = new Error('Label name and valid hex color are required');
    err.status = 400;
    throw err;
  }
  await assertUniqueLabelName(name);
  const id = randomUUID();
  try {
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name, color]);
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      error.status = 409;
      error.message = 'Label name already exists';
    }
    throw error;
  }
  const label = await getLabel(id);
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type: 'label:create', label, labels, board });
  return label;
}

async function updateLabel(id, nameInput, colorInput) {
  const existing = await getLabel(id);
  if (!existing) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  const name = nameInput === undefined ? existing.name : normalizeLabelName(nameInput);
  const color = colorInput === undefined ? existing.color : normalizeColor(colorInput);
  if (!name || !color) {
    const err = new Error('Label name and valid hex color are required');
    err.status = 400;
    throw err;
  }
  await assertUniqueLabelName(name, id);
  try {
    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [name, color, id]);
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      error.status = 409;
      error.message = 'Label name already exists';
    }
    throw error;
  }
  const label = await getLabel(id);
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type: 'label:update', label, labels, board });
  return label;
}

async function deleteLabel(id) {
  const existing = await getLabel(id);
  if (!existing) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  await db.query('DELETE FROM card_labels WHERE label_id = $1', [id]);
  await db.query('DELETE FROM labels WHERE id = $1', [id]);
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type: 'label:delete', label: existing, labels, board });
}

async function assignLabel(cardId, labelId) {
  const cardExists = await getCard(cardId);
  if (!cardExists) {
    const err = new Error('Card not found');
    err.status = 404;
    throw err;
  }
  const label = await getLabel(labelId);
  if (!label) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, labelId]);
  const card = await getCard(cardId);
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type: 'label:assign', card, label, labels, board });
  return card;
}

async function unassignLabel(cardId, labelId) {
  const cardExists = await getCard(cardId);
  if (!cardExists) {
    const err = new Error('Card not found');
    err.status = 404;
    throw err;
  }
  const label = await getLabel(labelId);
  if (!label) {
    const err = new Error('Label not found');
    err.status = 404;
    throw err;
  }
  await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
  const card = await getCard(cardId);
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type: 'label:unassign', card, label, labels, board });
  return card;
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
    const label = await createLabel(req.body?.name, req.body?.color);
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    res.json(await updateLabel(req.params.id, req.body?.name, req.body?.color));
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
    res.status(201).json(await assignLabel(req.params.id, labelId));
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
