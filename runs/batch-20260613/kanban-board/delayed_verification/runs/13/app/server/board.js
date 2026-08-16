import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Gap used when appending a new card to the end of a column.
const APPEND_GAP = 1024;
// Initial step used when renormalizing a column's positions.
const RENORMALIZE_STEP = 1024;
// Minimum separation we tolerate between two fractional positions before we
// consider precision to be exhausted and trigger a renormalize.
const MIN_GAP = 1e-9;

/**
 * Return the full board: every column ordered by position, each carrying its
 * cards ordered by position.
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards ORDER BY column_id, position ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) byColumn.set(col.id, []);
  for (const card of cards) {
    if (byColumn.has(card.column_id)) byColumn.get(card.column_id).push(card);
  }

  return columns.map((col) => ({
    id: col.id,
    title: col.title,
    position: col.position,
    cards: byColumn.get(col.id) || []
  }));
}

/**
 * Create a card at the end of a column. Returns the canonical card row.
 */
export async function createCard({ columnId, text }) {
  const db = getDb();

  // Validate the column exists.
  const { rows: cols } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (cols.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const trimmed = (text || '').trim();
  if (!trimmed) {
    const err = new Error('Card text is required');
    err.status = 400;
    throw err;
  }

  const id = randomUUID();
  let card;
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const max = rows[0].max;
    const position = (max === null || max === undefined ? 0 : Number(max)) + APPEND_GAP;
    const inserted = await tx.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, trimmed, position]
    );
    card = inserted.rows[0];
  });

  return card;
}

/**
 * Compute the desired fractional position for a card landing between the
 * cards identified by afterId (above) and beforeId (below) within a column.
 *
 * Returns { position } if a clean fractional slot exists, or
 * { needsRenormalize: true } when the neighbours are too close together.
 */
function computeBetween(afterPos, beforePos) {
  // afterPos = position of the card immediately ABOVE the drop slot.
  // beforePos = position of the card immediately BELOW the drop slot.
  if (afterPos === null && beforePos === null) {
    // Empty column.
    return { position: APPEND_GAP };
  }
  if (afterPos === null) {
    // Dropping at the very top.
    return { position: beforePos - APPEND_GAP };
  }
  if (beforePos === null) {
    // Dropping at the very bottom.
    return { position: afterPos + APPEND_GAP };
  }
  if (beforePos - afterPos <= MIN_GAP) {
    return { needsRenormalize: true };
  }
  return { position: afterPos + (beforePos - afterPos) / 2 };
}

/**
 * Renormalize all card positions in a column to evenly spaced integers,
 * preserving their current order. The moving card is inserted at the slot
 * determined by afterId/beforeId. Runs inside the provided transaction.
 *
 * Returns the final integer position assigned to the moving card.
 */
async function renormalizeColumn(tx, columnId, movingId, afterId, beforeId) {
  // Fetch the current ordering of the column EXCLUDING the moving card.
  const { rows } = await tx.query(
    `SELECT id, position FROM cards
     WHERE column_id = $1 AND id <> $2
     ORDER BY position ASC, id ASC`,
    [columnId, movingId]
  );

  // Determine insertion index based on neighbours.
  let insertIndex = rows.length; // default: append to end
  if (afterId) {
    const idx = rows.findIndex((r) => r.id === afterId);
    if (idx !== -1) insertIndex = idx + 1;
  } else if (beforeId) {
    const idx = rows.findIndex((r) => r.id === beforeId);
    if (idx !== -1) insertIndex = idx;
  } else {
    // No neighbours given: this is a top insert when both null only for empty;
    // for safety treat as append.
    insertIndex = rows.length;
  }

  // Build the final order with the moving card inserted.
  const finalOrder = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === insertIndex) finalOrder.push(movingId);
    finalOrder.push(rows[i].id);
  }
  if (insertIndex >= rows.length) finalOrder.push(movingId);

  // Assign evenly spaced integer positions.
  let movingPosition = RENORMALIZE_STEP;
  for (let i = 0; i < finalOrder.length; i++) {
    const pos = (i + 1) * RENORMALIZE_STEP;
    await tx.query('UPDATE cards SET position = $1, column_id = $2 WHERE id = $3', [
      pos,
      columnId,
      finalOrder[i]
    ]);
    if (finalOrder[i] === movingId) movingPosition = pos;
  }

  return movingPosition;
}

/**
 * Move a card into columnId, positioned between afterId (above) and beforeId
 * (below). The server is authoritative: it computes the canonical position,
 * persists column_id + position atomically, and returns the canonical card.
 *
 * If fractional precision is exhausted or a collision is detected, the column
 * is renormalized and a flag is returned so the caller can broadcast the
 * corrected order for the whole column.
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  const db = getDb();

  let result;
  await db.transaction(async (tx) => {
    // Lock/validate the card.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Validate the target column.
    const { rows: colRows } = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    // Resolve neighbour positions. Neighbours must currently belong to the
    // target column (and not be the moving card itself); otherwise we ignore
    // them (the client's optimistic guess may be stale).
    let afterPos = null;
    let beforePos = null;

    if (afterId && afterId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (rows.length) afterPos = Number(rows[0].position);
    }
    if (beforeId && beforeId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (rows.length) beforePos = Number(rows[0].position);
    }

    // If both neighbours are missing but the column is non-empty and no
    // explicit neighbours were supplied, this is an append.
    const computed = computeBetween(afterPos, beforePos);

    let renormalized = false;
    let finalPosition;

    if (computed.needsRenormalize) {
      finalPosition = await renormalizeColumn(tx, columnId, cardId, afterId, beforeId);
      renormalized = true;
    } else {
      finalPosition = computed.position;
      await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
        columnId,
        finalPosition,
        cardId
      ]);
    }

    const { rows: updated } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );

    result = { card: updated[0], renormalized, columnId };
  });

  // If we renormalized, fetch the full corrected column ordering so callers
  // can broadcast the authoritative order.
  if (result.renormalized) {
    const { rows } = await db.query(
      `SELECT id, column_id, text, position, created_at
       FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC`,
      [result.columnId]
    );
    result.column = { id: result.columnId, cards: rows };
  }

  return result;
}
