/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION numbers.  We use a base of 1000 so that
 * the initial gap between items is large enough to absorb many inserts
 * before renormalisation is needed.
 *
 * Renormalisation is triggered when the gap between two adjacent positions
 * falls below MIN_GAP (1e-9).
 */

const BASE = 1000;
const MIN_GAP = 1e-9;

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will come before
 *                                the new card (null → insert at start)
 * @param {number|null} after   - position of the card that will come after
 *                                the new card (null → insert at end)
 * @returns {number}
 */
export function between(before, after) {
  if (before === null && after === null) return BASE;
  if (before === null) return after - BASE;
  if (after === null) return before + BASE;
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
 * Given an ordered list of card rows (already sorted by position),
 * return a new array of { id, position } with evenly-spaced positions.
 *
 * @param {{ id: string }[]} cards
 * @returns {{ id: string, position: number }[]}
 */
export function renormalize(cards) {
  return cards.map((card, i) => ({
    id: card.id,
    position: (i + 1) * BASE,
  }));
}
