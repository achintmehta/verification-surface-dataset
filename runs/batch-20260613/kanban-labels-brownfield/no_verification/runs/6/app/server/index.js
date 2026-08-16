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
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeLabelName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function normalizeColor(color) {
  return typeof color === 'string' ? color.trim() : '';
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
      name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
      color TEXT NOT NULL CHECK (color LIKE '#%' AND length(color) IN (4, 7))
    )
  `);
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

async function getLabels(conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY lower(name) ASC, name ASC, id ASC');
  return result.rows;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const cardLabelsResult = await conn.query(`
    SELECT cl.card_id, l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC
  `).catch(() => ({ rows: [] }));

  const labelsByCard = new Map();
  for (const row of cardLabelsResult.rows) {
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
     FROM labels l
     JOIN card_labels cl ON cl.label_id = l.id
     WHERE cl.card_id = $1
     ORDER BY lower(l.name) ASC, l.name ASC, l.id ASC`,
    [id]
  ).catch(() => ({ rows: [] }));
  return { ...card, labels: labels.rows };
}

async function columnExists(columnId, conn = db) {
  const result = await conn.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) throw httpError(404, 'Column not found');

  const maxResult = await db.query('SELECT MAX(position)::float8 AS max_position FROM cards WHERE column_id = $1', [columnId]);
  const maxPosition = maxResult.rows[0].max_position == null ? 0 : Number(maxResult.rows[0].max_position);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, columnId, text, maxPosition + POSITION_STEP, createdAt]
  );

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  let moved = null;
  await db.query('BEGIN');
  try {
    const existing = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (existing.rows.length === 0) throw httpError(404, 'Card not found');
    if (!(await columnExists(columnId, db))) throw httpError(404, 'Column not found');

    const targetRows = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
      [columnId, cardId]
    );
    const ordered = targetRows.rows.map((row) => row.id);

    if (beforeId && !ordered.includes(beforeId)) throw httpError(400, 'beforeId must be a card in the target column');
    if (afterId && !ordered.includes(afterId)) throw httpError(400, 'afterId must be a card in the target column');
    if (beforeId && afterId && ordered.indexOf(afterId) >= ordered.indexOf(beforeId)) {
      throw httpError(400, 'afterId must come before beforeId in the target column');
    }

    let insertAt = ordered.length;
    if (afterId) insertAt = ordered.indexOf(afterId) + 1;
    else if (beforeId) insertAt = ordered.indexOf(beforeId);
    ordered.splice(Math.max(0, insertAt), 0, cardId);

    await db.query('UPDATE cards SET column_id = $1 WHERE id = $2', [columnId, cardId]);
    for (let i = 0; i < ordered.length; i += 1) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, ordered[i]]);
    }

    await db.query('COMMIT');
    moved = await getCard(cardId);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  const board = await getBoard();
  broadcast('mutation', { type: 'move', card: moved, columnId: moved.column_id, renormalized: true, board });
  return { card: moved, board, renormalized: true };
}

async function broadcastLabelsMutation(type, extra = {}) {
  const [labels, board] = await Promise.all([getLabels(), getBoard()]);
  broadcast('mutation', { type, labels, board, ...extra });
  return { labels, board };
}

async function createLabel(name, color) {
  const input = { name: normalizeLabelName(name), color: normalizeColor(color) };
  if (!input.name) throw httpError(400, 'Label name is required');
  if (!HEX_COLOR_RE.test(input.color)) throw httpError(400, 'Label color must be a valid hex value');
  const id = randomUUID();
  try {
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, input.name, input.color]);
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('unique')) throw httpError(409, 'Label name already exists');
    throw error;
  }
  const result = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  await broadcastLabelsMutation('label:create', { label: result.rows[0] });
  return result.rows[0];
}

async function updateLabel(id, body) {
  const exists = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  if (exists.rows.length === 0) throw httpError(404, 'Label not found');

  const updates = [];
  const values = [];
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = normalizeLabelName(body.name);
    if (!name) throw httpError(400, 'Label name is required');
    updates.push(`name = $${updates.length + 1}`);
    values.push(name);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'color')) {
    const color = normalizeColor(body.color);
    if (!HEX_COLOR_RE.test(color)) throw httpError(400, 'Label color must be a valid hex value');
    updates.push(`color = $${updates.length + 1}`);
    values.push(color);
  }
  if (updates.length === 0) return exists.rows[0];

  values.push(id);
  try {
    await db.query(`UPDATE labels SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('unique')) throw httpError(409, 'Label name already exists');
    throw error;
  }
  const result = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  await broadcastLabelsMutation('label:update', { label: result.rows[0] });
  return result.rows[0];
}

async function deleteLabel(id) {
  const exists = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  if (exists.rows.length === 0) throw httpError(404, 'Label not found');
  await db.query('DELETE FROM labels WHERE id = $1', [id]);
  await broadcastLabelsMutation('label:delete', { label: exists.rows[0], labelId: id });
}

async function assignLabel(cardId, labelId) {
  if (!(await getCard(cardId))) throw httpError(404, 'Card not found');
  const label = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [labelId]);
  if (label.rows.length === 0) throw httpError(404, 'Label not found');
  await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, labelId]);
  const card = await getCard(cardId);
  await broadcastLabelsMutation('label:assign', { card, label: label.rows[0], cardId, labelId });
  return card;
}

async function unassignLabel(cardId, labelId) {
  if (!(await getCard(cardId))) throw httpError(404, 'Card not found');
  await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
  const card = await getCard(cardId);
  await broadcastLabelsMutation('label:unassign', { card, cardId, labelId });
  return card;
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
    const { name, color } = req.body || {};
    const label = await createLabel(name, color);
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
