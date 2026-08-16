import { db, getBoard } from './db.js';
import { randomUUID } from 'node:crypto';

const POSITION_GAP = 1000;
// Minimum gap below which we consider fractional precision exhausted and
// renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Create a card at the end of a column.
 * Returns { card, columnId }.
 */
export async function createCard(columnId, text) {
  const col = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (col.rows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const maxRes = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRes.rows[0].max_pos) + POSITION_GAP;
  const id = randomUUID();

  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, text, position]
  );

  return {
    card: { id, columnId, text, position },
    columnId
  };
}

/**
 * Move a card into a target column, positioned between afterId and beforeId.
 *
 * - afterId: the card that should come immediately BEFORE the moved card
 *   (i.e. the moved card goes AFTER it). May be null => insert at top.
 * - beforeId: the card that should come immediately AFTER the moved card
 *   (i.e. the moved card goes BEFORE it). May be null => insert at bottom.
 *
 * The entire operation runs in a single transaction so the card never
 * appears in two columns. Returns the canonical state needed to broadcast,
 * including any renormalized column ordering.
 */
export async function moveCard(cardId, columnId, afterId, beforeId) {
  return await withTransaction(async () => {
    const cardRes = await db.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRes.rows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    const colRes = await db.query('SELECT id FROM columns WHERE id = $1', [
      columnId
    ]);
    if (colRes.rows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    const newPosition = await computePosition(columnId, cardId, afterId, beforeId);

    if (newPosition === null) {
      // Precision exhausted or collision; renormalize and place precisely.
      const card = await placeWithRenormalize(
        cardId,
        columnId,
        afterId,
        beforeId
      );
      const order = await columnOrder(columnId);
      return {
        card,
        columnId,
        renormalized: true,
        columnOrder: order
      };
    }

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    return {
      card: { id: cardId, columnId, position: newPosition },
      columnId,
      renormalized: false
    };
  });
}

/**
 * Compute a fractional position between the after/before neighbours.
 * Returns null if the gap is too small (precision exhausted) and a
 * renormalization is required. Neighbours are looked up by their current
 * positions in the TARGET column, excluding the moving card.
 */
async function computePosition(columnId, cardId, afterId, beforeId) {
  const afterPos = await neighbourPosition(columnId, afterId, cardId);
  const beforePos = await neighbourPosition(columnId, beforeId, cardId);

  let lower;
  let upper;

  if (afterPos === undefined && beforePos === undefined) {
    // Empty target (excluding moving card): position relative to existing cards.
    const maxRes = await db.query(
      'SELECT MAX(position) AS max_pos, MIN(position) AS min_pos FROM cards WHERE column_id = $1 AND id <> $2',
      [columnId, cardId]
    );
    const maxPos = maxRes.rows[0].max_pos;
    if (maxPos === null) {
      return POSITION_GAP; // truly empty
    }
    // No explicit neighbours but column non-empty: append to the end.
    return Number(maxPos) + POSITION_GAP;
  }

  if (afterPos === undefined) {
    // Insert at the very top: below the "before" card.
    upper = beforePos;
    lower = upper - POSITION_GAP;
    return (lower + upper) / 2;
  }

  if (beforePos === undefined) {
    // Insert at the very bottom: above the "after" card.
    lower = afterPos;
    return lower + POSITION_GAP;
  }

  lower = afterPos;
  upper = beforePos;

  if (upper - lower < MIN_GAP) {
    return null; // exhausted -> renormalize
  }
  return (lower + upper) / 2;
}

async function neighbourPosition(columnId, id, movingCardId) {
  if (!id || id === movingCardId) return undefined;
  const res = await db.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [id, columnId]
  );
  if (res.rows.length === 0) return undefined;
  return Number(res.rows[0].position);
}

/**
 * Renormalize a column to evenly-spaced integer positions while inserting
 * the moving card between afterId and beforeId. Returns the canonical card.
 */
async function placeWithRenormalize(cardId, columnId, afterId, beforeId) {
  // First move the card into the column (temporary position) so it is part
  // of the ordering pass.
  await db.query('UPDATE cards SET column_id = $1 WHERE id = $2', [
    columnId,
    cardId
  ]);

  // Get the existing ordering of the column excluding the moving card.
  const res = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId, cardId]
  );
  const ids = res.rows.map((r) => r.id);

  // Determine insertion index based on afterId / beforeId.
  let insertIdx;
  if (afterId && ids.includes(afterId)) {
    insertIdx = ids.indexOf(afterId) + 1;
  } else if (beforeId && ids.includes(beforeId)) {
    insertIdx = ids.indexOf(beforeId);
  } else if (afterId === null && beforeId !== null) {
    insertIdx = 0;
  } else {
    insertIdx = ids.length;
  }

  ids.splice(insertIdx, 0, cardId);

  // Reassign evenly spaced positions.
  let canonical = null;
  for (let i = 0; i < ids.length; i++) {
    const pos = (i + 1) * POSITION_GAP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, ids[i]]);
    if (ids[i] === cardId) {
      canonical = { id: cardId, columnId, position: pos };
    }
  }
  return canonical;
}

async function columnOrder(columnId) {
  const res = await db.query(
    'SELECT id, column_id, text, position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    columnId: r.column_id,
    text: r.text,
    position: Number(r.position)
  }));
}

async function withTransaction(fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await db.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export { getBoard };
