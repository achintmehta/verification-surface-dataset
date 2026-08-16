/**
 * Fractional position ordering helpers.
 *
 * Cards within a column are ordered by a DOUBLE PRECISION `position` value.
 * Inserting between two cards uses the midpoint of their positions.
 *
 * Constants:
 *   POSITION_GAP   – initial spacing between cards (1000 units)
 *   MIN_GAP        – minimum gap before renormalisation is triggered
 *
 * Exports:
 *   computePosition(before, after)  – midpoint between two nullable positions
 *   needsRenorm(positions)          – true when any adjacent gap < MIN_GAP
 *   renormalize(positions)          – evenly-spaced positions for an ordered list
 */

export const POSITION_GAP = 1000;
export const MIN_GAP = 1e-9; // IEEE 754 double has ~15 significant digits

/**
 * Compute the insertion position between `after` and `before`.
 *
 * Semantics (matching the PATCH /api/cards/:id/move API):
 *   afterId  – the card that will be immediately ABOVE the inserted card (lower position)
 *   beforeId – the card that will be immediately BELOW the inserted card (higher position)
 *
 * @param {number|null} afterPos   – position of the card above (null = insert at top)
 * @param {number|null} beforePos  – position of the card below (null = insert at bottom)
 * @param {number}      maxPos     – current maximum position in the column (for append)
 * @returns {number}
 */
export function computePosition(afterPos, beforePos, maxPos) {
  if (afterPos === null && beforePos === null) {
    // Empty column or no neighbours provided – place at a sensible default
    return POSITION_GAP;
  }
  if (afterPos === null) {
    // Insert before the first card
    return beforePos / 2;
  }
  if (beforePos === null) {
    // Append after the last card
    return afterPos + POSITION_GAP;
  }
  // Midpoint
  return (afterPos + beforePos) / 2;
}

/**
 * Return true when any adjacent pair of positions is closer than MIN_GAP,
 * indicating that floating-point precision is about to be exhausted.
 *
 * @param {number[]} positions – sorted ascending
 * @returns {boolean}
 */
export function needsRenorm(positions) {
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - positions[i - 1] < MIN_GAP) return true;
  }
  return false;
}

/**
 * Produce a new array of evenly-spaced positions for `count` items,
 * starting at POSITION_GAP and incrementing by POSITION_GAP.
 *
 * @param {number} count
 * @returns {number[]}
 */
export function renormalize(count) {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_GAP);
}
