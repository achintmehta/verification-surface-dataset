import { getDb } from './db.js';

// Gap used when appending cards at the end of a column and when
// renormalizing positions.
const POSITION_GAP = 1000;

// Minimum acceptable gap between two adjacent fractional positions. If a
// computed gap would fall below this, we treat it as precision exhaustion
// and renormalize the whole column.
const MIN_GAP = 1e-6;

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
    'SELECT id, column_id, text, position FROM cards ORDER BY position ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }

  return { columns: Array.from(byColumn.values()) };
}

/**
 * Create a new card at the end of the given column.
 * @returns {Promise<{id:number, column_id:number, text:string, position:number}>}
 */
export async function createCard(columnId, text) {
  const db = getDb();

  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const max = maxRows[0].max;
  const position = (max == null ? 0 : Number(max)) + POSITION_GAP;

  const { rows } = await db.query(
    'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING id, column_id, text, position',
    [columnId, text, position]
  );
  return rows[0];
}

/**
 * Compute a fractional position for a card being placed between `afterId`
 * (the card immediately above it) and `beforeId` (the card immediately below
 * it) within `columnId`. Returns the canonical card and, when renormalization
 * was required, the corrected ordering of the affected column.
 *
 * The whole operation runs in a single transaction so that no client can ever
 * observe the same card in two columns, and broadcasts only happen on commit.
 *
 * @returns {Promise<{ card: object, normalizedColumn?: {columnId:number, cards:object[]} }>}
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = getDb();

  return db.transaction(async (tx) => {
    // Validate the card exists.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Validate the target column exists.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    // Resolve the neighbour positions within the target column, ignoring the
    // card being moved (it may already be in this column).
    let afterPos = null; // position of the card above the insertion point
    let beforePos = null; // position of the card below the insertion point

    if (afterId != null) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
        [afterId, columnId, cardId]
      );
      if (rows.length > 0) afterPos = Number(rows[0].position);
    }
    if (beforeId != null) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
        [beforeId, columnId, cardId]
      );
      if (rows.length > 0) beforePos = Number(rows[0].position);
    }

    // Compute the new position from the resolved neighbours.
    const newPosition = computePosition(afterPos, beforePos);

    let needNormalize = newPosition == null;

    if (!needNormalize) {
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );
    } else {
      // Precision exhaustion / collision: place the card provisionally between
      // the neighbours using the midpoint anyway, then renormalize the column
      // so every position is well spaced and ordering is preserved.
      const provisional = provisionalPosition(afterPos, beforePos);
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, provisional, cardId]
      );
    }

    let normalizedColumn;
    if (needNormalize) {
      normalizedColumn = await renormalizeColumn(tx, columnId);
    }

    // Re-read the canonical card after all updates.
    const { rows: finalRows } = await tx.query(
      'SELECT id, column_id, text, position FROM cards WHERE id = $1',
      [cardId]
    );

    return { card: finalRows[0], normalizedColumn };
  });
}

/**
 * Compute a fractional position between `afterPos` (above) and `beforePos`
 * (below). Returns null when the available gap is too small (precision
 * exhaustion), signalling that the column must be renormalized.
 */
function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // Empty column (relative to this card).
    return POSITION_GAP;
  }
  if (afterPos == null) {
    // Insert at the very top.
    return beforePos - POSITION_GAP;
  }
  if (beforePos == null) {
    // Insert at the very bottom.
    return afterPos + POSITION_GAP;
  }
  // Insert between two cards.
  const gap = beforePos - afterPos;
  if (gap <= MIN_GAP) {
    return null; // exhausted / collision
  }
  return afterPos + gap / 2;
}

/**
 * A best-effort position used right before renormalization. It does not need
 * to be precise because the column is about to be rewritten with even spacing.
 */
function provisionalPosition(afterPos, beforePos) {
  if (afterPos != null && beforePos != null) return (afterPos + beforePos) / 2;
  if (afterPos != null) return afterPos + MIN_GAP / 2;
  if (beforePos != null) return beforePos - MIN_GAP / 2;
  return POSITION_GAP;
}

/**
 * Rewrite every card's position within a column to evenly spaced values,
 * preserving the current order. Returns the corrected ordering.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  for (let i = 0; i < rows.length; i++) {
    const pos = (i + 1) * POSITION_GAP;
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
      pos,
      rows[i].id,
    ]);
  }
  const { rows: cards } = await tx.query(
    'SELECT id, column_id, text, position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  return { columnId, cards };
}
