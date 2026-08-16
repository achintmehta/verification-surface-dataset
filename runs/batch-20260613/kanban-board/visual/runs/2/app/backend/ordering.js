/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION numbers.  We use a gap of 1000 between
 * "round" positions so there is plenty of room for inserts before
 * renormalisation is needed.
 *
 * Renormalisation is triggered when the gap between two adjacent positions
 * falls below MIN_GAP (2^-40 ≈ 9e-13), which is well above the limits of
 * IEEE-754 double precision.
 */

const BASE_GAP = 1000;
const MIN_GAP  = 1 / (2 ** 40); // ~9.09e-13

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will come before the new one (null = insert at start)
 * @param {number|null} after   - position of the card that will come after  the new one (null = insert at end)
 * @returns {number}
 */
export function between(before, after) {
  if (before === null && after === null) return BASE_GAP;
  if (before === null) return after - BASE_GAP;
  if (after  === null) return before + BASE_GAP;
  return (before + after) / 2;
}

/**
 * Check whether the gap between two adjacent positions is too small.
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function needsRenorm(a, b) {
  return Math.abs(b - a) < MIN_GAP;
}

/**
 * Given an ordered array of cards (already sorted by position), return a new
 * array with evenly-spaced positions starting at BASE_GAP.
 *
 * @param {{ id: string, position: number }[]} cards
 * @returns {{ id: string, position: number }[]}
 */
export function renormalize(cards) {
  return cards.map((card, i) => ({
    ...card,
    position: BASE_GAP * (i + 1),
  }));
}
