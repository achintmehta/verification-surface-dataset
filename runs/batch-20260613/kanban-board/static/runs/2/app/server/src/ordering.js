/**
 * Ordering utilities for fractional position arithmetic.
 *
 * Each card has a DOUBLE PRECISION `position` within its column.
 * Inserting between two cards uses the midpoint of their positions.
 *
 * Collision / precision exhaustion is detected when the gap between
 * adjacent positions falls below MIN_GAP, triggering a full renormalization
 * of that column's positions.
 */

import { getDb } from './db.js';

/** Minimum gap before we consider positions exhausted and renormalize. */
const MIN_GAP = 1e-9;

/** Spacing used when renormalizing a column's positions. */
const RENORM_STEP = 1000;

/**
 * Compute a new position for a card being inserted between `afterPos` and `beforePos`.
 *
 * @param {number|null} afterPos  - position of the card immediately before the target slot (null = insert at start)
 * @param {number|null} beforePos - position of the card immediately after the target slot (null = insert at end)
 * @param {number} maxPos         - current maximum position in the column (used when inserting at end)
 * @returns {number}
 */
export function computePosition(afterPos, beforePos, maxPos) {
  if (afterPos === null && beforePos === null) {
    // Only card in column
    return RENORM_STEP;
  }
  if (afterPos === null) {
    // Insert before the first card
    return beforePos / 2;
  }
  if (beforePos === null) {
    // Insert after the last card
    return afterPos + RENORM_STEP;
  }
  // Insert between two cards
  return (afterPos + beforePos) / 2;
}

/**
 * Check whether the column needs renormalization after inserting a card at `newPos`
 * between `afterPos` and `beforePos`.
 *
 * @param {number|null} afterPos
 * @param {number|null} beforePos
 * @param {number} newPos
 * @returns {boolean}
 */
export function needsRenorm(afterPos, beforePos, newPos) {
  if (afterPos !== null && Math.abs(newPos - afterPos) < MIN_GAP) return true;
  if (beforePos !== null && Math.abs(beforePos - newPos) < MIN_GAP) return true;
  return false;
}

/**
 * Renormalize all card positions in a column, spacing them RENORM_STEP apart.
 * Runs inside the caller's transaction context (db must already be in a transaction).
 *
 * @param {string} columnId
 * @returns {Promise<Array<{id:string, position:number}>>} updated cards
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();

  // Fetch current order
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  // Assign evenly-spaced positions
  const updates = rows.map((row, idx) => ({
    id: row.id,
    position: (idx + 1) * RENORM_STEP,
  }));

  for (const { id, position } of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
  }

  return updates;
}

/**
 * Compute the new position for a move operation, persist it, and—if needed—
 * renormalize the target column.  Returns the full updated card row plus a
 * flag indicating whether a renormalization occurred.
 *
 * Must be called inside a transaction.
 *
 * @param {string} cardId
 * @param {string} columnId
 * @param {string|null} afterId  - id of the card that will be immediately above the moved card
 * @param {string|null} beforeId - id of the card that will be immediately below the moved card
 * @returns {Promise<{card: object, renormalized: boolean, renormPositions?: Array}>}
 */
export async function computeAndPersistMove(cardId, columnId, afterId, beforeId) {
  const db = getDb();

  // Resolve neighbour positions
  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const { rows } = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [afterId, columnId]
    );
    if (rows.length) afterPos = rows[0].position;
  }

  if (beforeId) {
    const { rows } = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [beforeId, columnId]
    );
    if (rows.length) beforePos = rows[0].position;
  }

  // If neither neighbour was found in the target column, append at end
  if (afterId && afterPos === null && beforeId && beforePos === null) {
    afterId = null;
    beforeId = null;
  }

  // Get current max position in target column (excluding the card being moved)
  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1 AND id != $2',
    [columnId, cardId]
  );
  const maxPos = maxRows[0].maxpos;

  const newPos = computePosition(afterPos, beforePos, maxPos);

  // Persist the move
  await db.query(
    'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
    [columnId, newPos, cardId]
  );

  // Check for precision exhaustion
  let renormalized = false;
  let renormPositions;

  if (needsRenorm(afterPos, beforePos, newPos)) {
    renormPositions = await renormalizeColumn(columnId);
    renormalized = true;
  }

  // Fetch the canonical card state
  const { rows: cardRows } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [cardId]
  );

  return { card: cardRows[0], renormalized, renormPositions };
}
