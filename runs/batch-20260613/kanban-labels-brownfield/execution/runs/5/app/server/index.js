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

// ── hex color validation ──────────────────────────────────────────────────────
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function isValidHex(color) {
  return typeof color === 'string' && HEX_RE.test(color);
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

  // ── additive label tables ─────────────────────────────────────────────────
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

// ── label helpers ─────────────────────────────────────────────────────────────

async function getCardLabels(conn = db) {
  // Returns a Map<cardId, label[]>
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

  const cardLabelsMap = await getCardLabels(conn);

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
  const labelsResult = await conn.query(
    `SELECT l.id, l.name, l.color FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = $1 ORDER BY l.name ASC`,
    [id]
  );
  return { ...result.rows[0], labels: labelsResult.rows };
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
  if (afterPosition != null && position <= Number(afterPosition)) return true;
  if (beforePosition != null && position >= Number(beforePosition)) return true;
  return false;
}

async function getCardInColumn(cardId, columnId, role, conn = db) {
  if (!cardId) return null;
  const result = await conn.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [cardId, columnId]);
  if (result.rows.length === 0) {
    const err = new Error(`${role} card not found in target column`);
    err.status = 400;
    throw err;
  }
  return result.rows[0];
}

async function renormalizeColumn(conn, columnId, movedCardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  const ids = result.rows.map((r) => r.id);

  // Ensure movedCardId is placed between afterId and beforeId
  const filtered = ids.filter((id) => id !== movedCardId);
  const afterIndex = afterId ? filtered.indexOf(afterId) : -1;
  const beforeIndex = beforeId ? filtered.indexOf(beforeId) : -1;
  let insertAt = filtered.length;
  if (afterIndex !== -1) insertAt = afterIndex + 1;
  else if (beforeIndex !== -1) insertAt = beforeIndex;
  filtered.splice(insertAt, 0, movedCardId);

  for (let i = 0; i < filtered.length; i++) {
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * POSITION_STEP, filtered[i]]);
  }
}

async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();

  const maxResult = await db.query('SELECT MAX(position) AS max FROM cards WHERE column_id = $1', [columnId]);
  const maxPos = maxResult.rows[0].max;
  const position = maxPos == null ? POSITION_STEP : Number(maxPos) + POSITION_STEP;

  await db.query('INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)', [
    id,
    columnId,
    text,
    position,
    createdAt,
  ]);

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, board });
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

    const before = await getCardInColumn(beforeId, columnId, 'beforeId');
    const after = await getCardInColumn(afterId, columnId, 'afterId');

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

// ── existing board / card routes ──────────────────────────────────────────────

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

// ── label CRUD routes ─────────────────────────────────────────────────────────

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
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    if (!isValidHex(color)) {
      return res.status(400).json({ error: 'color must be a valid hex value (e.g. #a1b2c3)' });
    }
    const trimmedName = name.trim();
    const existing = await db.query('SELECT id FROM labels WHERE name = $1', [trimmedName]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A label with that name already exists' });
    }
    const id = randomUUID();
    await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, trimmedName, color]);
    const label = { id, name: trimmedName, color };
    broadcast('label', { type: 'label-created', label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, color } = req.body || {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    if (!isValidHex(color)) {
      return res.status(400).json({ error: 'color must be a valid hex value (e.g. #a1b2c3)' });
    }
    const trimmedName = name.trim();
    const existing = await db.query('SELECT id FROM labels WHERE name = $1 AND id <> $2', [trimmedName, id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A label with that name already exists' });
    }
    const result = await db.query(
      'UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color',
      [trimmedName, color, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    const label = result.rows[0];
    broadcast('label', { type: 'label-updated', label });
    res.json(label);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM labels WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    broadcast('label', { type: 'label-deleted', labelId: id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ── card-label assignment routes ──────────────────────────────────────────────

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const { labelId } = req.body || {};
    if (!labelId) {
      return res.status(400).json({ error: 'labelId is required' });
    }
    const cardCheck = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }
    const labelCheck = await db.query('SELECT id FROM labels WHERE id = $1', [labelId]);
    if (labelCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    // INSERT OR IGNORE equivalent — ignore duplicate
    await db.query(
      'INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [cardId, labelId]
    );
    const card = await getCard(cardId);
    broadcast('label', { type: 'card-label-assigned', cardId, labelId, card });
    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const { id: cardId, labelId } = req.params;
    const result = await db.query(
      'DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2 RETURNING card_id',
      [cardId, labelId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const card = await getCard(cardId);
    broadcast('label', { type: 'card-label-unassigned', cardId, labelId, card });
    res.json(card);
  } catch (error) {
    next(error);
  }
});

// ── SSE stream ────────────────────────────────────────────────────────────────

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
