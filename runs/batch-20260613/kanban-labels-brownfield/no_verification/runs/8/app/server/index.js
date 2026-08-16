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
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_card ON card_labels(card_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_label ON card_labels(label_id)');

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

async function getLabelsForCard(cardId, conn = db) {
  const result = await conn.query(
    `SELECT l.id, l.name, l.color
       FROM card_labels cl
       JOIN labels l ON l.id = cl.label_id
      WHERE cl.card_id = $1
      ORDER BY lower(l.name) ASC, l.id ASC`,
    [cardId]
  );
  return result.rows;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const labelsResult = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
       FROM card_labels cl
       JOIN labels l ON l.id = cl.label_id
      ORDER BY lower(l.name) ASC, l.id ASC`
  );

  const labelsByCard = new Map();
  for (const row of labelsResult.rows) {
    if (!labelsByCard.has(row.card_id)) labelsByCard.set(row.card_id, []);
    labelsByCard.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const rawCard of cardsResult.rows) {
    const card = { ...rawCard, labels: labelsByCard.get(rawCard.id) || [] };
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
  return { columns };
}

async function getMutationPayload(extra = {}) {
  const board = await getBoard();
  const labels = await getLabels();
  return { ...extra, board, labels };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  return { ...result.rows[0], labels: await getLabelsForCard(id, conn) };
}

async function getLabel(id, conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function columnExists(columnId, conn = db) {
  const result = await conn.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

async function cardExists(cardId, conn = db) {
  const result = await conn.query('SELECT id FROM cards WHERE id = $1', [cardId]);
  return result.rows.length > 0;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function validateLabelInput(body, existing = null) {
  const next = { ...existing };
  if (!existing || Object.prototype.hasOwnProperty.call(body, 'name')) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw httpError(400, 'Label name must be non-empty');
    }
    next.name = body.name.trim().slice(0, 100);
  }
  if (!existing || Object.prototype.hasOwnProperty.call(body, 'color')) {
    if (typeof body.color !== 'string' || !HEX_COLOR_RE.test(body.color)) {
      throw httpError(400, 'Label color must be a hex value like #2563eb');
    }
    next.color = body.color.toLowerCase();
  }
  return next;
}

async function ensureUniqueLabelName(name, exceptId = null) {
  const result = exceptId
    ? await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1', [name, exceptId])
    : await db.query('SELECT id FROM labels WHERE lower(name) = lower($1) LIMIT 1', [name]);
  if (result.rows.length > 0) throw httpError(409, 'A label with that name already exists');
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
  return Math.abs(position) > Number.MAX_SAFE_INTEGER / 4;
}

async function getNeighbor(cardId, columnId, neighborId, name) {
  if (neighborId == null) return null;
  if (neighborId === cardId) throw httpError(400, `${name} cannot refer to the moving card`);
  const result = await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [neighborId, columnId]);
  if (result.rows.length === 0) throw httpError(400, `${name} must be a card in the target column`);
  return result.rows[0];
}

async function renormalizeColumn(conn, columnId, movedCardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  const ordered = result.rows.map((row) => row.id).filter((id) => id !== movedCardId);
  let insertAt = ordered.length;
  if (afterId) {
    const index = ordered.indexOf(afterId);
    if (index !== -1) insertAt = index + 1;
  } else if (beforeId) {
    const index = ordered.indexOf(beforeId);
    if (index !== -1) insertAt = index;
  }
  ordered.splice(insertAt, 0, movedCardId);
  for (let i = 0; i < ordered.length; i += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, ordered[i]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) throw httpError(404, 'Column not found');
  const max = await db.query('SELECT MAX(position) AS max FROM cards WHERE column_id = $1', [columnId]);
  const position = max.rows[0].max == null ? POSITION_STEP : Number(max.rows[0].max) + POSITION_STEP;
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
  broadcast('mutation', await getMutationPayload({ type: 'create', card, columnId }));
  return { card };
}

async function moveCard(cardId, columnId, beforeId = null, afterId = null) {
  const existing = await getCard(cardId);
  if (!existing) throw httpError(404, 'Card not found');
  if (!(await columnExists(columnId))) throw httpError(404, 'Column not found');

  let renormalized = false;
  await db.query('BEGIN');
  try {
    const before = await getNeighbor(cardId, columnId, beforeId, 'beforeId');
    const after = await getNeighbor(cardId, columnId, afterId, 'afterId');

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
  broadcast('mutation', await getMutationPayload({ type: 'move', card, columnId: card.column_id, renormalized }));
  return { card, renormalized };
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
    const labelInput = validateLabelInput(req.body || {});
    await ensureUniqueLabelName(labelInput.name);
    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, labelInput.name, labelInput.color]);
    const label = await getLabel(id);
    const payload = await getMutationPayload({ type: 'label:create', label });
    broadcast('mutation', payload);
    res.status(201).json(label);
  } catch (error) {
    if (error.code === '23505') error.status = 409;
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const existing = await getLabel(req.params.id);
    if (!existing) throw httpError(404, 'Label not found');
    const labelInput = validateLabelInput(req.body || {}, existing);
    await ensureUniqueLabelName(labelInput.name, existing.id);
    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [labelInput.name, labelInput.color, existing.id]);
    const label = await getLabel(existing.id);
    const payload = await getMutationPayload({ type: 'label:update', label });
    broadcast('mutation', payload);
    res.json(label);
  } catch (error) {
    if (error.code === '23505') error.status = 409;
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const label = await getLabel(req.params.id);
    if (!label) throw httpError(404, 'Label not found');
    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM card_labels WHERE label_id = $1', [label.id]);
      await db.query('DELETE FROM labels WHERE id = $1', [label.id]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    const payload = await getMutationPayload({ type: 'label:delete', label });
    broadcast('mutation', payload);
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
    if (!(await cardExists(req.params.id))) throw httpError(404, 'Card not found');
    const label = await getLabel(labelId);
    if (!label) throw httpError(404, 'Label not found');
    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      req.params.id,
      labelId,
    ]);
    const card = await getCard(req.params.id);
    const payload = await getMutationPayload({ type: 'label:assign', card, label });
    broadcast('mutation', payload);
    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    if (!(await cardExists(req.params.id))) throw httpError(404, 'Card not found');
    const label = await getLabel(req.params.labelId);
    if (!label) throw httpError(404, 'Label not found');
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    const payload = await getMutationPayload({ type: 'label:unassign', card, label });
    broadcast('mutation', payload);
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
  const status = err.status || (err.code === '23505' ? 409 : 500);
  const message = status === 409 ? 'A label with that name already exists' : err.message || 'Internal server error';
  res.status(status).json({ error: message });
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
