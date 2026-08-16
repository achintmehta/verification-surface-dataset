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
  const error = new Error(message);
  error.status = status;
  return error;
}

function isValidHexColor(color) {
  return typeof color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
}

function normalizeLabelInput(body, partial = false) {
  const input = body || {};
  const label = {};
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'name')) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw httpError(400, 'A non-empty label name is required');
    }
    label.name = input.name.trim().slice(0, 100);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'color')) {
    if (!isValidHexColor(input.color)) {
      throw httpError(400, 'A valid hex label color is required');
    }
    label.color = input.color;
  }
  if (partial && label.name == null && label.color == null) {
    throw httpError(400, 'Label name or color is required');
  }
  return label;
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
      label_id TEXT NOT NULL REFERENCES labels(id),
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
  const result = await conn.query('SELECT id, name, color FROM labels ORDER BY name ASC, id ASC');
  return result.rows;
}

async function attachLabels(cards, conn = db) {
  if (cards.length === 0) return cards;
  const ids = cards.map((card) => card.id);
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
  const labelResult = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
       FROM card_labels cl
       JOIN labels l ON l.id = cl.label_id
      WHERE cl.card_id IN (${placeholders})
      ORDER BY l.name ASC, l.id ASC`,
    ids
  );
  const byCard = new Map(cards.map((card) => [card.id, []]));
  for (const row of labelResult.rows) {
    byCard.get(row.card_id)?.push({ id: row.id, name: row.name, color: row.color });
  }
  return cards.map((card) => ({ ...card, labels: byCard.get(card.id) || [] }));
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );

  const cards = await attachLabels(cardsResult.rows, conn);
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
  if (result.rows.length === 0) return null;
  return (await attachLabels(result.rows, conn))[0];
}

async function getLabel(id, conn = db) {
  const result = await conn.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function columnExists(columnId, conn = db) {
  const result = await conn.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  return result.rows.length > 0;
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
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

async function getNeighbor(cardId, columnId, label, conn = db) {
  if (cardId == null) return null;
  const result = await conn.query('SELECT id, column_id, position FROM cards WHERE id = $1', [cardId]);
  const card = result.rows[0];
  if (!card) throw httpError(400, `${label} does not exist`);
  if (card.column_id !== columnId) throw httpError(400, `${label} must be in the target column`);
  return card;
}

async function renormalizeColumn(conn, columnId, movedCardId = null, afterId = null, beforeId = null) {
  const result = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  const cards = result.rows.filter((card) => card.id !== movedCardId);
  if (movedCardId) {
    const moved = result.rows.find((card) => card.id === movedCardId);
    if (moved) {
      let insertAt = cards.length;
      if (afterId) {
        const afterIndex = cards.findIndex((card) => card.id === afterId);
        if (afterIndex !== -1) insertAt = afterIndex + 1;
      } else if (beforeId) {
        const beforeIndex = cards.findIndex((card) => card.id === beforeId);
        if (beforeIndex !== -1) insertAt = beforeIndex;
      }
      cards.splice(insertAt, 0, moved);
    }
  }
  for (let index = 0; index < cards.length; index += 1) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(index + 1) * POSITION_STEP, cards[index].id]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) throw httpError(400, 'columnId does not exist');
  const tail = await db.query('SELECT MAX(position) AS position FROM cards WHERE column_id = $1', [columnId]);
  const position = tail.rows[0].position == null ? POSITION_STEP : Number(tail.rows[0].position) + POSITION_STEP;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, columnId, text, position, createdAt]
  );
  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId = null, afterId = null) {
  const existing = await getCard(cardId);
  if (!existing) throw httpError(404, 'Card not found');
  if (!(await columnExists(columnId))) throw httpError(400, 'columnId does not exist');
  if (beforeId && beforeId === cardId) beforeId = null;
  if (afterId && afterId === cardId) afterId = null;

  let renormalized = false;
  await db.query('BEGIN');
  try {
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

async function broadcastLabelMutation(type, extra = {}) {
  const board = await getBoard();
  const labels = await getLabels();
  broadcast('mutation', { type, ...extra, labels, board });
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
    const input = normalizeLabelInput(req.body);
    const id = randomUUID();
    try {
      await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, input.name, input.color]);
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('unique')) throw httpError(409, 'A label with that name already exists');
      throw error;
    }
    const label = await getLabel(id);
    await broadcastLabelMutation('label:create', { label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const input = normalizeLabelInput(req.body, true);
    const current = await getLabel(req.params.id);
    if (!current) throw httpError(404, 'Label not found');
    const nextName = input.name ?? current.name;
    const nextColor = input.color ?? current.color;
    try {
      await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [nextName, nextColor, req.params.id]);
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('unique')) throw httpError(409, 'A label with that name already exists');
      throw error;
    }
    const label = await getLabel(req.params.id);
    await broadcastLabelMutation('label:update', { label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const label = await getLabel(req.params.id);
    if (!label) throw httpError(404, 'Label not found');
    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM card_labels WHERE label_id = $1', [req.params.id]);
      await db.query('DELETE FROM labels WHERE id = $1', [req.params.id]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
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
    if (!labelId) throw httpError(400, 'labelId is required');
    const card = await getCard(req.params.id);
    if (!card) throw httpError(404, 'Card not found');
    const label = await getLabel(labelId);
    if (!label) throw httpError(404, 'Label not found');
    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, labelId]);
    const updatedCard = await getCard(req.params.id);
    await broadcastLabelMutation('label:assign', { card: updatedCard, label });
    res.status(201).json(updatedCard);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const card = await getCard(req.params.id);
    if (!card) throw httpError(404, 'Card not found');
    const label = await getLabel(req.params.labelId);
    if (!label) throw httpError(404, 'Label not found');
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const updatedCard = await getCard(req.params.id);
    await broadcastLabelMutation('label:unassign', { card: updatedCard, labelId: req.params.labelId });
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
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
