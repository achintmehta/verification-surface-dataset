/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION numbers.  We use a base of 1000 so that
 * initial seeds are 1000, 2000, 3000 … and there is plenty of room between
 * any two adjacent values.
 *
 * Renormalisation is triggered when the gap between two adjacent positions
 * falls below MIN_GAP.
 */

const BASE      = 1000;
const MIN_GAP   = 1e-9; // renormalise when gap is smaller than this

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will come before the new one (null = insert at start)
 * @param {number|null} after   - position of the card that will come after  the new one (null = insert at end)
 * @returns {number}
 */
export function between(before, after) {
  if (before === null && after === null) return BASE;
  if (before === null) return after - BASE;
  if (after  === null) return before + BASE;
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
 * Given an ordered array of cards (already sorted by position ascending),
 * return a new array of { id, position } with evenly-spaced positions
 * starting at BASE and incrementing by BASE.
 *
 * @param {{ id: string, position: number }[]} cards
 * @returns {{ id: string, position: number }[]}
 */
export function renormalize(cards) {
  return cards.map((card, i) => ({
    id:       card.id,
    position: BASE * (i + 1),
  }));
}
