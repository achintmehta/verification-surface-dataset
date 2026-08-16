import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Gap used when appending to the end of a column or normalizing positions.
const POSITION_STEP = 1000;

// Minimum gap between two adjacent positions before we consider precision
// exhausted and renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Return the full board: all columns ordered by position, each with its
 * cards ordered by position.
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position,
            EXTRACT(EPOCH FROM created_at) AS created_at
     FROM cards
     ORDER BY position ASC, created_at ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }

  return { columns: columns.map((c) => byColumn.get(c.id)) };
}

/**
 * Create a card at the end of the given column.
 * Returns the canonical card row.
 */
export async function createCard(columnId, text) {
  const db = getDb();

  // Validate the column exists.
  const { rows: cols } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (cols.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].max_pos) + POSITION_STEP;
  const id = randomUUID();

  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position,
               EXTRACT(EPOCH FROM created_at) AS created_at`,
    [id, columnId, text, position]
  );

  return rows[0];
}

/**
 * Compute the target position for a card landing between afterId and beforeId
 * within a column, renormalizing the column if necessary.
 *
 * Semantics of the move intent:
 *   - afterId:  the id of the card that should end up immediately ABOVE the
 *               moved card (i.e. the moved card goes after it).
 *   - beforeId: the id of the card that should end up immediately BELOW the
 *               moved card (i.e. the moved card goes before it).
 *
 * The move is performed atomically in a single transaction. The function
 * returns the canonical card row plus, when renormalization occurred, the
 * corrected ordering of the affected column(s).
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = getDb();

  let result;
  await db.transaction(async (tx) => {
    // Load the card being moved (lock-free; PGLite is single-connection).
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Validate target column.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    const sourceColumnId = cardRows[0].column_id;

    // Resolve neighbor positions within the TARGET column, ignoring the card
    // being moved itself (it may already be in this column).
    const afterPos = await neighborPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighborPosition(tx, columnId, beforeId, cardId);

    let newPosition = computeBetween(afterPos, beforePos);

    // First, move the card into the target column / position.
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    // Detect collision or precision exhaustion in the target column and
    // renormalize if needed.
    const needsRenorm = await columnNeedsRenormalization(tx, columnId);
    const renormalizedColumns = [];
    if (needsRenorm) {
      await renormalizeColumn(tx, columnId);
      renormalizedColumns.push(columnId);
    }

    // Re-read the canonical card after any renormalization.
    const { rows: finalRows } = await tx.query(
      `SELECT id, column_id, text, position,
              EXTRACT(EPOCH FROM created_at) AS created_at
       FROM cards WHERE id = $1`,
      [cardId]
    );

    result = {
      card: finalRows[0],
      sourceColumnId,
      renormalizedColumns,
    };
  });

  // Attach corrected ordering for any renormalized columns so clients can snap.
  if (result.renormalizedColumns.length > 0) {
    result.columns = {};
    for (const colId of result.renormalizedColumns) {
      result.columns[colId] = await getColumnOrder(colId);
    }
  }

  return result;
}

/**
 * Resolve the position of a neighbor card id within a column. Returns null if
 * the id is null/undefined or does not exist in that column.
 */
async function neighborPosition(tx, columnId, neighborId, movingCardId) {
  if (!neighborId || neighborId === movingCardId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Compute a position strictly between afterPos and beforePos.
 *  - both null  -> column is empty (well, the card is the only one): use STEP.
 *  - afterPos null (insert at top): beforePos - STEP.
 *  - beforePos null (insert at end): afterPos + STEP.
 *  - both set: midpoint.
 */
function computeBetween(afterPos, beforePos) {
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
 * Check whether the column has any duplicate positions or adjacent positions
 * that are too close together (precision exhaustion).
 */
async function columnNeedsRenormalization(tx, columnId) {
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  for (let i = 1; i < rows.length; i++) {
    const prev = Number(rows[i - 1].position);
    const cur = Number(rows[i].position);
    if (cur - prev < MIN_GAP) {
      return true;
    }
  }
  return false;
}

/**
 * Renormalize a column: reassign evenly spaced positions to all cards,
 * preserving their current relative order.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  let pos = POSITION_STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += POSITION_STEP;
  }
}

/**
 * Return the canonical ordering of a column as an array of cards.
 */
async function getColumnOrder(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, column_id, text, position,
            EXTRACT(EPOCH FROM created_at) AS created_at
     FROM cards WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return rows;
}
