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
  // --- End labels migration ---

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

async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );

  // Fetch all card-label assignments with label details
  const cardLabelsResult = await conn.query(
    `SELECT cl.card_id, l.id, l.name, l.color
     FROM card_labels cl
     JOIN labels l ON l.id = cl.label_id
     ORDER BY l.name ASC`
  );

  // Build a map: card_id -> array of labels
  const cardLabelsMap = new Map();
  for (const row of cardLabelsResult.rows) {
    if (!cardLabelsMap.has(row.card_id)) {
      cardLabelsMap.set(row.card_id, []);
    }
    cardLabelsMap.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) {
      column.cards.push({
        ...card,
        labels: cardLabelsMap.get(card.id) || [],
      });
    }
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  const card = result.rows[0];
  // Attach labels
  const labelsResult = await conn.query(
    `SELECT l.id, l.name, l.color
     FROM card_labels cl JOIN labels l ON l.id = cl.label_id
     WHERE cl.card_id = $1 ORDER BY l.name ASC`,
    [id]
  );
  card.labels = labelsResult.rows;
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
  if (afterPosition != null && Math.abs(position - Number(afterPosition)) < 1e-9) return true;
  if (beforePosition != null && Math.abs(position - Number(beforePosition)) < 1e-9) return true;
  return false;
}

async function renormalizeColumn(conn, columnId, cardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );

  let ids = result.rows.map((r) => r.id);
  ids = ids.filter((id) => id !== cardId);

  let insertIndex = ids.length;
  if (afterId) {
    const ai = ids.indexOf(afterId);
    if (ai !== -1) insertIndex = ai + 1;
  } else if (beforeId) {
    const bi = ids.indexOf(beforeId);
    if (bi !== -1) insertIndex = bi;
  }
  ids.splice(insertIndex, 0, cardId);

  for (let i = 0; i < ids.length; i++) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, ids[i]]);
  }
}

async function resolveAnchor(columnId, anchorId, label) {
  if (!anchorId) return null;
  const result = await db.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [anchorId, columnId]);
  if (result.rows.length === 0) {
    const err = new Error(`${label} card not found in target column`);
    err.status = 400;
    throw err;
  }
  return result.rows[0];
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const last = await db.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC LIMIT 1',
    [columnId]
  );
  const position = last.rows.length > 0 ? Number(last.rows[0].position) + POSITION_STEP : POSITION_STEP;
  await db.query(
    'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, columnId, text, position, createdAt]
  );

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  if (!(await columnExists(columnId))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }
  const existing = await getCard(cardId);
  if (!existing) {
    const err = new Error('Card not found');
    err.status = 404;
    throw err;
  }

  let renormalized = false;

  try {
    await db.query('BEGIN');

    const before = await resolveAnchor(columnId, beforeId, 'beforeId');
    const after = await resolveAnchor(columnId, afterId, 'afterId');

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

// --- Hex color validation ---
function isValidHexColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

// ===================== ROUTES =====================

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

// ===================== LABEL CRUD =====================

app.get('/api/labels', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id, name, color FROM labels ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/labels', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Non-empty name is required' });
    }
    if (!isValidHexColor(color)) {
      return res.status(400).json({ error: 'color must be a valid hex value (e.g. #ff0000)' });
    }
    const trimmedName = name.trim();
    // Check uniqueness
    const existing = await db.query('SELECT id FROM labels WHERE name = $1', [trimmedName]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A label with that name already exists' });
    }
    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, trimmedName, color]);
    const label = { id, name: trimmedName, color };
    broadcast('mutation', { type: 'label-created', label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, color } = req.body || {};
    // Check label exists
    const existing = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    const updates = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Non-empty name is required' });
      }
      const trimmedName = name.trim();
      // Check uniqueness (allow same name if same id)
      const dup = await db.query('SELECT id FROM labels WHERE name = $1 AND id <> $2', [trimmedName, id]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'A label with that name already exists' });
      }
      updates.name = trimmedName;
    }
    if (color !== undefined) {
      if (!isValidHexColor(color)) {
        return res.status(400).json({ error: 'color must be a valid hex value (e.g. #ff0000)' });
      }
      updates.color = color;
    }
    const newName = updates.name ?? existing.rows[0].name;
    const newColor = updates.color ?? existing.rows[0].color;
    await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3', [newName, newColor, id]);
    const label = { id, name: newName, color: newColor };
    broadcast('mutation', { type: 'label-updated', label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await db.query('SELECT id FROM labels WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    // card_labels will be cascaded via ON DELETE CASCADE
    await db.query('DELETE FROM labels WHERE id = $1', [id]);
    broadcast('mutation', { type: 'label-deleted', labelId: id });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ===================== CARD-LABEL ASSIGNMENT =====================

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { labelId } = req.body || {};
    if (!labelId) {
      return res.status(400).json({ error: 'labelId is required' });
    }
    // Verify card exists
    const cardCheck = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }
    // Verify label exists
    const labelCheck = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [labelId]);
    if (labelCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    // Check if already assigned
    const existingAssignment = await db.query(
      'SELECT card_id FROM card_labels WHERE card_id = $1 AND label_id = $2',
      [cardId, labelId]
    );
    if (existingAssignment.rows.length === 0) {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [cardId, labelId]);
    }
    const label = labelCheck.rows[0];
    broadcast('mutation', { type: 'label-assigned', cardId, label });
    res.json({ ok: true, cardId, label });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const { id: cardId, labelId } = req.params;
    // Verify card exists
    const cardCheck = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
    broadcast('mutation', { type: 'label-unassigned', cardId, labelId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ===================== SSE =====================

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
