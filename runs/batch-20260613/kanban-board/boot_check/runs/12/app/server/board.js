import { getDb } from './db.js';

// Spacing used when appending cards or renormalizing a column.
const POSITION_STEP = 1000;
// If the gap between two neighbours becomes smaller than this, we renormalize
// to avoid floating-point precision exhaustion.
const MIN_GAP = 1e-6;

/**
 * Return the full board: ordered columns, each with its ordered cards.
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id ASC, position ASC, id ASC`
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
    cards: byColumn.get(col.id) || [],
  }));
}

/**
 * Create a card at the end of a column.
 * Returns the canonical card row.
 */
export async function createCard(columnId, text) {
  const db = getDb();

  // Validate column exists.
  const { rows: cols } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (cols.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].maxpos) + POSITION_STEP;

  const { rows } = await db.query(
    `INSERT INTO cards (column_id, text, position)
     VALUES ($1, $2, $3)
     RETURNING id, column_id, text, position, created_at`,
    [columnId, text, position]
  );
  return rows[0];
}

/**
 * Compute the new position for a card placed between afterId and beforeId
 * within a column. `afterId` is the card immediately above the drop slot,
 * `beforeId` is the card immediately below it. Either may be null.
 *
 * Returns { position, renormalized } where `renormalized` is true if the
 * column needed to be renormalized due to collision/precision exhaustion.
 *
 * This runs inside a transaction (the passed `tx` object).
 */
async function computePosition(tx, columnId, movingId, beforeId, afterId) {
  // Fetch ordered positions in the target column, excluding the moving card.
  const { rows: siblings } = await tx.query(
    `SELECT id, position FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, id ASC`,
    [columnId, movingId]
  );

  const posOf = (id) => {
    if (id == null) return null;
    const row = siblings.find((s) => Number(s.id) === Number(id));
    return row ? Number(row.position) : null;
  };

  let afterPos = posOf(afterId); // the card above the slot
  let beforePos = posOf(beforeId); // the card below the slot

  let lower;
  let upper;

  if (afterPos != null && beforePos != null) {
    lower = Math.min(afterPos, beforePos);
    upper = Math.max(afterPos, beforePos);
  } else if (afterPos != null) {
    // Insert after the last/anchor card -> at the end relative to it.
    lower = afterPos;
    upper = null;
  } else if (beforePos != null) {
    // Insert before the first/anchor card -> at the start relative to it.
    lower = null;
    upper = beforePos;
  } else {
    // Empty column (or no valid neighbours): place in the middle.
    lower = null;
    upper = null;
  }

  let position;
  if (lower != null && upper != null) {
    position = (lower + upper) / 2;
    // Detect collision / precision exhaustion.
    if (!(position > lower && position < upper) || upper - lower < MIN_GAP) {
      return { needsRenormalize: true, beforeId, afterId };
    }
  } else if (lower != null) {
    position = lower + POSITION_STEP;
  } else if (upper != null) {
    position = upper - POSITION_STEP;
  } else {
    position = POSITION_STEP;
  }

  return { position, needsRenormalize: false };
}

/**
 * Move a card to `columnId` between afterId and beforeId.
 * Atomic: all writes happen inside a single transaction; only committed state
 * is returned/broadcast, so a card is never observable in two columns.
 *
 * Returns { card, renormalizedColumn } where:
 *   - card is the canonical moved card row.
 *   - renormalizedColumn (optional) is { columnId, cards } when a renormalize
 *     occurred and the whole column's order must be re-broadcast.
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const db = getDb();

  return db.transaction(async (tx) => {
    // Verify card exists.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Verify target column exists.
    const { rows: colRows } = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    const result = await computePosition(tx, columnId, cardId, beforeId, afterId);

    if (result.needsRenormalize) {
      // Move the card into the column first with a placeholder position, then
      // renormalize the entire target column so the moved card lands in its
      // intended slot relative to afterId/beforeId.
      const renorm = await renormalizeColumnWithInsert(
        tx,
        columnId,
        cardId,
        result.beforeId,
        result.afterId
      );
      const { rows: moved } = await tx.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );
      return { card: moved[0], renormalizedColumn: renorm };
    }

    await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      result.position,
      cardId,
    ]);

    const { rows: moved } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    return { card: moved[0], renormalizedColumn: null };
  });
}

/**
 * Renormalize an entire column's positions to evenly spaced integers while
 * inserting the moving card at the slot defined by (afterId, beforeId).
 * Returns the canonical ordered cards of the column after renormalization.
 */
async function renormalizeColumnWithInsert(tx, columnId, movingId, beforeId, afterId) {
  // Current order of the column excluding the moving card.
  const { rows: others } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, id ASC`,
    [columnId, movingId]
  );

  const orderedIds = others.map((r) => Number(r.id));

  // Determine insertion index.
  let insertIndex;
  if (afterId != null && orderedIds.includes(Number(afterId))) {
    insertIndex = orderedIds.indexOf(Number(afterId)) + 1;
  } else if (beforeId != null && orderedIds.includes(Number(beforeId))) {
    insertIndex = orderedIds.indexOf(Number(beforeId));
  } else if (afterId == null && beforeId != null) {
    insertIndex = 0;
  } else {
    insertIndex = orderedIds.length;
  }

  orderedIds.splice(insertIndex, 0, Number(movingId));

  // Reassign evenly spaced positions and move card into the column.
  for (let i = 0; i < orderedIds.length; i++) {
    const pos = (i + 1) * POSITION_STEP;
    await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      pos,
      orderedIds[i],
    ]);
  }

  const { rows: cards } = await tx.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards WHERE column_id = $1
      ORDER BY position ASC, id ASC`,
    [columnId]
  );
  return { columnId, cards };
}
