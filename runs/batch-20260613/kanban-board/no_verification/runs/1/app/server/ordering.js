/**
 * Ordering utilities for fractional-position Kanban cards.
 *
 * Strategy
 * --------
 * Each card has a DOUBLE PRECISION `position` value within its column.
 * Inserting between two cards uses the midpoint of their positions.
 * When the gap becomes too small (< MIN_GAP) we renormalize the whole
 * column by spreading cards evenly with STEP spacing.
 *
 * Constants are chosen so that:
 *   - STEP (1000) gives plenty of room for inserts before renormalization.
 *   - MIN_GAP (1e-9) is well above IEEE-754 double precision limits.
 */

const STEP = 1000;
const MIN_GAP = 1e-9;

/**
 * Compute the position for a card being inserted between `after` and `before`.
 *
 * @param {number|null} afterPos  - position of the card immediately above the target slot (null = top)
 * @param {number|null} beforePos - position of the card immediately below the target slot (null = bottom)
 * @param {number}      maxPos    - current maximum position in the column (used when appending)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(afterPos, beforePos, maxPos) {
  let position;

  if (afterPos === null && beforePos === null) {
    // Empty column or no neighbours — start at STEP
    position = STEP;
  } else if (afterPos === null) {
    // Insert before the first card
    position = beforePos / 2;
  } else if (beforePos === null) {
    // Append after the last card
    position = afterPos + STEP;
  } else {
    // Insert between two cards
    position = (afterPos + beforePos) / 2;
  }

  const gap =
    afterPos !== null && beforePos !== null
      ? beforePos - afterPos
      : Infinity;

  return {
    position,
    needsRenorm: gap < MIN_GAP * 2,
  };
}

/**
 * Renormalize all cards in a column: assign evenly-spaced positions
 * starting at STEP with increment STEP.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} columnId
 * @returns {Promise<Array<{id: string, position: number}>>} updated cards
 */
export async function renormalizeColumn(db, columnId) {
  // Fetch current order
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const updates = rows.map((row, idx) => ({
    id: row.id,
    position: (idx + 1) * STEP,
  }));

  // Apply updates inside the current transaction context (caller wraps in tx)
  for (const { id, position } of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      position,
      id,
    ]);
  }

  return updates;
}

/**
 * Return the STEP constant so callers can use it for initial inserts.
 */
export { STEP };
