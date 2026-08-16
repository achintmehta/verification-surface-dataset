/**
 * Ordering & position utilities for fractional indexing.
 */

/** Default gap used when appending a card to the end of a column. */
const DEFAULT_GAP = 1024;

/** Minimum gap before we trigger renormalization. */
const MIN_GAP = 1e-9;

/**
 * Compute a position value between two neighbours.
 * - If both are null we default to DEFAULT_GAP (first card in column).
 * - If afterPos is null we place after beforePos with a gap.
 * - If beforePos is null we place before afterPos with a gap.
 * - Otherwise we average.
 *
 * @param {number | null} afterPos   – position of the card after which we insert (lower)
 * @param {number | null} beforePos  – position of the card before which we insert (higher)
 * @returns {number}
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    return DEFAULT_GAP;
  }
  if (afterPos == null) {
    // Insert at the very beginning – half of the first card's position
    return /** @type {number} */ (beforePos) / 2;
  }
  if (beforePos == null) {
    // Insert at the very end – add gap
    return /** @type {number} */ (afterPos) + DEFAULT_GAP;
  }
  return (afterPos + beforePos) / 2;
}

/**
 * Check whether a newly computed position is too close to its neighbours,
 * indicating that we should renormalize.
 *
 * @param {number} newPos
 * @param {number | null} afterPos
 * @param {number | null} beforePos
 * @returns {boolean}
 */
export function needsRenormalization(newPos, afterPos, beforePos) {
  if (afterPos != null && Math.abs(newPos - afterPos) < MIN_GAP) return true;
  if (beforePos != null && Math.abs(beforePos - newPos) < MIN_GAP) return true;
  return false;
}

/**
 * Renormalize all card positions in a column by assigning evenly-spaced values.
 * Returns the new positions keyed by card id.
 *
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} columnId
 * @returns {Promise<Array<{id: string, position: number}>>}
 */
export async function renormalizeColumn(db, columnId) {
  const { rows } = await db.query(
    "SELECT id FROM cards WHERE column_id = $1 ORDER BY position, created_at",
    [columnId]
  );

  /** @type {Array<{id: string, position: number}>} */
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const newPos = (i + 1) * DEFAULT_GAP;
    updates.push({ id: rows[i].id, position: newPos });
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [newPos, rows[i].id]);
  }
  return updates;
}

export { DEFAULT_GAP };
