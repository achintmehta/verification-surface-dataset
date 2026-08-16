import { randomUUID } from 'node:crypto';
import { db } from './db.js';

const POSITION_STEP = 1000;
// Minimum gap between two adjacent fractional positions before we treat the
// space as exhausted and renormalize the whole column.
const MIN_GAP = 1e-6;

/**
 * Return the full board: all columns ordered by position, each with its cards
 * ordered by position.
 */
export async function getBoard() {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position FROM cards ORDER BY column_id ASC, position ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of columns) byColumn.set(col.id, []);
  for (const card of cards) {
    if (byColumn.has(card.column_id)) {
      byColumn.get(card.column_id).push({
        id: card.id,
        columnId: card.column_id,
        text: card.text,
        position: card.position,
      });
    }
  }

  return columns.map((col) => ({
    id: col.id,
    title: col.title,
    position: col.position,
    cards: byColumn.get(col.id) || [],
  }));
}

async function columnExists(columnId) {
  const { rows } = await db.query('SELECT 1 FROM columns WHERE id = $1', [columnId]);
  return rows.length > 0;
}

/**
 * Create a card at the END of the given column.
 * Returns the canonical card row.
 */
export async function createCard(columnId, text) {
  if (!(await columnExists(columnId))) {
    throw new ApiError(400, 'Unknown columnId');
  }
  const trimmed = (text || '').toString().trim();
  if (!trimmed) {
    throw new ApiError(400, 'Card text is required');
  }

  const { rows } = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = rows[0].max;
  const position = (maxPos == null ? 0 : Number(maxPos)) + POSITION_STEP;

  const id = randomUUID();
  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, trimmed, position]
  );

  return { id, columnId, text: trimmed, position };
}

/**
 * Move card `cardId` into `columnId`, placed between `afterId` and `beforeId`.
 *
 * Semantics (matches client drop intent):
 *   - afterId  = the card that should end up immediately ABOVE the moved card
 *   - beforeId = the card that should end up immediately BELOW the moved card
 *   - either may be null (top/bottom of the column)
 *
 * The whole operation runs in a single transaction so no client ever observes
 * the card in two columns. If fractional space is exhausted, the target
 * column is renormalized and the corrected order is returned for broadcast.
 *
 * Returns { card, renormalizedColumns: [{ columnId, cards: [...] }] }
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  return withTransaction(async () => {
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, text FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      throw new ApiError(404, 'Card not found');
    }
    const card = cardRows[0];

    if (!(await columnExists(columnId))) {
      throw new ApiError(400, 'Unknown target columnId');
    }

    // Resolve neighbor positions. Neighbors must currently belong to the
    // target column (ignore stale references otherwise).
    const afterPos = await neighborPosition(afterId, columnId, cardId);
    const beforePos = await neighborPosition(beforeId, columnId, cardId);

    let newPosition = computePosition(afterPos, beforePos);

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    const renormalizedColumns = [];

    // Detect collisions / exhaustion in the target column and renormalize.
    if (await needsRenormalization(columnId)) {
      const corrected = await renormalizeColumn(columnId);
      renormalizedColumns.push(corrected);
      newPosition = corrected.cards.find((c) => c.id === cardId)?.position ?? newPosition;
    }

    return {
      card: {
        id: card.id,
        columnId,
        text: card.text,
        position: newPosition,
      },
      renormalizedColumns,
    };
  });
}

async function neighborPosition(neighborId, columnId, movingCardId) {
  if (!neighborId || neighborId === movingCardId) return null;
  const { rows } = await db.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    return POSITION_STEP;
  }
  if (afterPos == null) {
    return beforePos - POSITION_STEP;
  }
  if (beforePos == null) {
    return afterPos + POSITION_STEP;
  }
  return (afterPos + beforePos) / 2;
}

/**
 * A column needs renormalization if any two adjacent cards have positions that
 * are equal or closer than MIN_GAP (precision exhaustion / collision).
 */
async function needsRenormalization(columnId) {
  const { rows } = await db.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  for (let i = 1; i < rows.length; i++) {
    const prev = Number(rows[i - 1].position);
    const cur = Number(rows[i].position);
    if (cur - prev < MIN_GAP) return true;
  }
  return false;
}

/**
 * Re-assign clean evenly-spaced positions to every card in the column,
 * preserving current order. Returns the corrected card list for broadcast.
 */
async function renormalizeColumn(columnId) {
  const { rows } = await db.query(
    'SELECT id, text FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  const cards = [];
  for (let i = 0; i < rows.length; i++) {
    const position = (i + 1) * POSITION_STEP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, rows[i].id]);
    cards.push({ id: rows[i].id, columnId, text: rows[i].text, position });
  }
  return { columnId, cards };
}

async function withTransaction(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
