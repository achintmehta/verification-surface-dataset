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
      name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
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
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_name_lower ON labels(lower(name))');
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
  `);

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
  return { columns, labels: await getLabels(conn) };
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
  if (afterPosition != null && !(position > Number(afterPosition))) return true;
  if (beforePosition != null && !(position < Number(beforePosition))) return true;
  if (afterPosition != null && Math.abs(position - Number(afterPosition)) < 1e-9) return true;
  if (beforePosition != null && Math.abs(Number(beforePosition) - position) < 1e-9) return true;
  return false;
}

async function validateNeighbor(conn, neighborId, columnId, movedCardId, label) {
  if (!neighborId) return null;
  if (neighborId === movedCardId) return null;
  const result = await conn.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [neighborId, columnId]);
  if (result.rows.length === 0) {
    const err = new Error(`${label} card is not in the target column`);
    err.status = 400;
    throw err;
  }
  return result.rows[0];
}

async function renormalizeColumn(conn, columnId, movedCardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId, movedCardId]
  );
  const ids = result.rows.map((row) => row.id);

  let insertAt = ids.length;
  if (afterId && afterId !== movedCardId) {
    const index = ids.indexOf(afterId);
    if (index >= 0) insertAt = index + 1;
  } else if (beforeId && beforeId !== movedCardId) {
    const index = ids.indexOf(beforeId);
    if (index >= 0) insertAt = index;
  } else if (!afterId && beforeId && beforeId !== movedCardId) {
    const index = ids.indexOf(beforeId);
    if (index >= 0) insertAt = index;
  } else if (!afterId && !beforeId) {
    insertAt = ids.length;
  }

  ids.splice(insertAt, 0, movedCardId);
  let movedPosition = POSITION_STEP;
  for (let i = 0; i < ids.length; i++) {
    const position = (i + 1) * POSITION_STEP;
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [position, ids[i]]);
    if (ids[i] === movedCardId) movedPosition = position;
  }
  return movedPosition;
}

async function createCard(columnId, text) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await db.query('BEGIN');
  try {
    if (!(await columnExists(columnId, db))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }
    const max = await db.query('SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1', [columnId]);
    const position = Number(max.rows[0].max) + POSITION_STEP;
    await db.query(
      'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, columnId, text, position, createdAt]
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId: card.column_id, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  let renormalized = false;

  await db.query('BEGIN');
  try {
    if (!(await columnExists(columnId, db))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    const card = await getCard(cardId, db);
    if (!card) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    const before = await validateNeighbor(db, beforeId, columnId, cardId, 'beforeId');
    const after = await validateNeighbor(db, afterId, columnId, cardId, 'afterId');

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

function normalizeLabelInput(body, partial = false) {
  const result = {};
  if (!partial || Object.prototype.hasOwnProperty.call(body || {}, 'name')) {
    if (typeof body?.name !== 'string' || body.name.trim().length === 0) {
      const err = new Error('Label name must be non-empty');
      err.status = 400;
      throw err;
    }
    result.name = body.name.trim().slice(0, 100);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body || {}, 'color')) {
    if (typeof body?.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(body.color.trim())) {
      const err = new Error('Label color must be a valid hex value like #2563eb');
      err.status = 400;
      throw err;
    }
    result.color = body.color.trim().toLowerCase();
  }
  return result;
}

function isUniqueViolation(error) {
  return error?.code === '23505' || String(error?.message || '').toLowerCase().includes('duplicate key');
}

async function broadcastLabelMutation(type, extra = {}) {
  const board = await getBoard();
  broadcast('mutation', { type, labels: board.labels, board, ...extra });
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
    const { name, color } = normalizeLabelInput(req.body);
    const id = randomUUID();
    try {
      await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name, color]);
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'Label name already exists' });
      throw error;
    }
    const label = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id])).rows[0];
    await broadcastLabelMutation('label:create', { label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const current = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    const input = normalizeLabelInput(req.body, true);
    const name = input.name ?? current.rows[0].name;
    const color = input.color ?? current.rows[0].color;
    try {
      await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [name, color, req.params.id]);
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'Label name already exists' });
      throw error;
    }
    const label = (await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id])).rows[0];
    await broadcastLabelMutation('label:update', { label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const current = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    await db.query('DELETE FROM labels WHERE id = $1', [req.params.id]);
    await broadcastLabelMutation('label:delete', { label: current.rows[0] });
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
    if (!(await cardExists(req.params.id))) return res.status(404).json({ error: 'Card not found' });
    if (!(await labelExists(labelId))) return res.status(404).json({ error: 'Label not found' });
    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const card = await getCard(req.params.id);
    await broadcastLabelMutation('label:assign', { card, labelId });
    res.status(201).json(card);
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
