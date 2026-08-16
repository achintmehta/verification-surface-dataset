// Fractional position ordering utilities

const POSITION_GAP = 1000;
const MIN_GAP = 0.0001; // below this we renormalize

/**
 * Compute a position value between `before` and `after`.
 * - If both are null, return POSITION_GAP (first card in column).
 * - If only `after` is null, return before + POSITION_GAP (append).
 * - If only `before` is null, return after / 2 (prepend).
 * - Otherwise, return (before + after) / 2 (insert between).
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    return POSITION_GAP;
  }
  if (afterPos == null) {
    // Prepend: before the first card
    return beforePos / 2;
  }
  if (beforePos == null) {
    // Append: after the last card
    return afterPos + POSITION_GAP;
  }
  return (afterPos + beforePos) / 2;
}

/**
 * Check if a gap is too small and needs renormalization.
 */
export function needsRenormalization(afterPos, beforePos) {
  if (afterPos == null || beforePos == null) return false;
  return Math.abs(beforePos - afterPos) < MIN_GAP;
}

/**
 * Renormalize all positions in a column, evenly spaced.
 * Returns the new positions as an array of {id, position}.
 */
export async function renormalizeColumn(db, columnId) {
  const { rows } = await db.query(
    "SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC",
    [columnId]
  );
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    updates.push({ id: rows[i].id, position: newPos });
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [newPos, rows[i].id]);
  }
  return updates;
}

export { POSITION_GAP };
