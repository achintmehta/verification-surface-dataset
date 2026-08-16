/**
 * Fractional-position ordering utilities.
 *
 * Positions are stored as DOUBLE PRECISION (float8) in PostgreSQL.
 * We use a base of 1000 so there is plenty of room between integers,
 * and we detect exhaustion when the gap between two neighbours falls
 * below MIN_GAP, triggering a full renormalization of the column.
 */

const BASE = 1000;
const MIN_GAP = 1e-9; // below this we must renormalize

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will be above (smaller pos), or null
 * @param {number|null} after   - position of the card that will be below (larger pos), or null
 * @returns {number}
 */
export function between(before, after) {
  if (before === null && after === null) return BASE;
  if (before === null) return after - BASE;
  if (after === null) return before + BASE;
  return (before + after) / 2;
}

/**
 * Check whether the computed position is too close to its neighbours
 * (i.e. precision is exhausted).
 *
 * @param {number} pos
 * @param {number|null} before
 * @param {number|null} after
 * @returns {boolean}
 */
export function needsRenormalization(pos, before, after) {
  if (before !== null && Math.abs(pos - before) < MIN_GAP) return true;
  if (after !== null && Math.abs(pos - after) < MIN_GAP) return true;
  return false;
}

/**
 * Produce a fresh, evenly-spaced array of positions for `count` items.
 * Returns positions [BASE, 2*BASE, 3*BASE, …].
 *
 * @param {number} count
 * @returns {number[]}
 */
export function renormalizedPositions(count) {
  return Array.from({ length: count }, (_, i) => (i + 1) * BASE);
}
