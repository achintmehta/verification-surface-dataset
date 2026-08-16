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

  // --- Labels: additive migration ---
  await db.query(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
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
  await db.query('CREATE INDEX IF NOT EXISTS idx_card_labels_label ON card_labels(label_id)');
  // --- end labels migration ---

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

async function getLabelsForCards(conn = db) {
  const result = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
     FROM card_labels cl
     JOIN labels l ON l.id = cl.label_id
     ORDER BY l.name ASC`
  );
  const map = new Map();
  for (const row of result.rows) {
    if (!map.has(row.card_id)) map.set(row.card_id, []);
    map.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }
  return map;
}

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const cardLabelsMap = await getLabelsForCards(conn);

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) column.cards.push({ ...card, labels: cardLabelsMap.get(card.id) || [] });
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  const card = result.rows[0];
  const labelsResult = await conn.query(
    `SELECT l.id, l.name, l.color FROM labels l JOIN card_labels cl ON cl.label_id = l.id WHERE cl.card_id = $1 ORDER BY l.name ASC`,
    [id]
  );
  return { ...card, labels: labelsResult.rows };
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

function positionIsUnsafe(pos, after, before) {
  if (after != null && pos <= Number(after)) return true;
  if (before != null && pos >= Number(before)) return true;
  return false;
}

async function resolveNeighbor(columnId, neighborId, label) {
  if (!neighborId) return null;
  const result = await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [neighborId, columnId]);
  if (result.rows.length === 0) {
    const err = new Error(`${label} "${neighborId}" not found in column "${columnId}"`);
    err.status = 400;
    throw err;
  }
  return result.rows[0];
}

async function renormalizeColumn(conn, columnId, movedId, afterId, beforeId) {
  const rows = (await conn.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  )).rows;

  const ids = rows.map((r) => r.id);
  const movedIndex = ids.indexOf(movedId);
  if (movedIndex !== -1) ids.splice(movedIndex, 1);

  let insertAt = ids.length;
  if (afterId) {
    const ai = ids.indexOf(afterId);
    if (ai !== -1) insertAt = ai + 1;
  } else if (beforeId) {
    const bi = ids.indexOf(beforeId);
    if (bi !== -1) insertAt = bi;
  }
  ids.splice(insertAt, 0, movedId);

  for (let i = 0; i < ids.length; i++) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, ids[i]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error(`Column "${columnId}" does not exist`);
    err.status = 400;
    throw err;
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const maxResult = await db.query('SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1', [columnId]);
  const position = Number(maxResult.rows[0].max_pos) + POSITION_STEP;

  await db.query('INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)', [
    id, columnId, text, position, createdAt,
  ]);

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  const card = await getCard(cardId);
  if (!card) {
    const err = new Error(`Card "${cardId}" not found`);
    err.status = 404;
    throw err;
  }
  if (!(await columnExists(columnId))) {
    const err = new Error(`Column "${columnId}" does not exist`);
    err.status = 400;
    throw err;
  }

  let renormalized = false;

  try {
    await db.query('BEGIN');
    const before = await resolveNeighbor(columnId, beforeId, 'beforeId');
    const after = await resolveNeighbor(columnId, afterId, 'afterId');

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

  const updatedCard = await getCard(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'move', card: updatedCard, columnId: updatedCard.column_id, renormalized, board });
  return { card: updatedCard, board, renormalized };
}

// ---- Hex color validation ----
function isValidHex(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color) || /^#[0-9a-fA-F]{3}$/.test(color);
}

// ============= ROUTES =============

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

// ============= LABEL ROUTES =============

// GET /api/labels — list all labels
app.get('/api/labels', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id, name, color FROM labels ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

// POST /api/labels — create a label
app.post('/api/labels', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required and must be non-empty' });
    }
    if (!color || typeof color !== 'string' || !isValidHex(color)) {
      return res.status(400).json({ error: 'color must be a valid hex value (e.g. #ff0000)' });
    }

    // Check uniqueness
    const existing = await db.query('SELECT id FROM labels WHERE name = $1', [name.trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A label with that name already exists' });
    }

    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name.trim(), color]);
    const label = { id, name: name.trim(), color };

    broadcast('mutation', { type: 'label-created', label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

// PUT /api/labels/:id — update a label
app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    const labelId = req.params.id;

    const existing = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [labelId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }

    const updatedName = (name !== undefined && typeof name === 'string' && name.trim().length > 0) ? name.trim() : existing.rows[0].name;
    const updatedColor = (color !== undefined && typeof color === 'string' && isValidHex(color)) ? color : existing.rows[0].color;

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({ error: 'name must be non-empty' });
    }
    if (color !== undefined && (typeof color !== 'string' || !isValidHex(color))) {
      return res.status(400).json({ error: 'color must be a valid hex value' });
    }

    // Check unique name (different from self)
    if (updatedName !== existing.rows[0].name) {
      const dup = await db.query('SELECT id FROM labels WHERE name = $1 AND id <> $2', [updatedName, labelId]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'A label with that name already exists' });
      }
    }

    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [updatedName, updatedColor, labelId]);
    const label = { id: labelId, name: updatedName, color: updatedColor };

    broadcast('mutation', { type: 'label-updated', label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/labels/:id — delete a label and its assignments
app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const labelId = req.params.id;
    const existing = await db.query('SELECT id FROM labels WHERE id = $1', [labelId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }

    // card_labels has ON DELETE CASCADE, but let's be explicit
    await db.query('DELETE FROM card_labels WHERE label_id = $1', [labelId]);
    await db.query('DELETE FROM labels WHERE id = $1', [labelId]);

    broadcast('mutation', { type: 'label-deleted', labelId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/cards/:id/labels — assign a label to a card
app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { labelId } = req.body || {};

    if (!labelId) {
      return res.status(400).json({ error: 'labelId is required' });
    }

    // Check card exists
    const cardResult = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Check label exists
    const labelResult = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [labelId]);
    if (labelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }

    // Check not already assigned
    const dup = await db.query('SELECT card_id FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
    if (dup.rows.length > 0) {
      return res.json({ ok: true, label: labelResult.rows[0] });
    }

    await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [cardId, labelId]);

    const label = labelResult.rows[0];
    broadcast('mutation', { type: 'label-assigned', cardId, label });
    res.status(201).json({ ok: true, label });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/cards/:id/labels/:labelId — unassign a label from a card
app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const { id: cardId, labelId } = req.params;

    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);

    broadcast('mutation', { type: 'label-unassigned', cardId, labelId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ============= SSE =============

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
