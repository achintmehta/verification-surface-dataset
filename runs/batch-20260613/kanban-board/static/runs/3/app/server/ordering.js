/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION values.  We use a gap of 1000 between
 * "round" positions so there is plenty of room for insertions before
 * renormalisation is needed.
 *
 * Renormalisation is triggered when the gap between two adjacent positions
 * falls below MIN_GAP (2^-40 ≈ 9e-13), which is well above the limits of
 * IEEE-754 double precision.
 */

export const INITIAL_GAP = 1000;
export const MIN_GAP     = 1e-9;

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will come before
 *                                the new card (null → insert at the start)
 * @param {number|null} after   - position of the card that will come after
 *                                the new card (null → insert at the end)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function between(before, after) {
  const lo = before ?? 0;
  const hi = after  ?? lo + INITIAL_GAP * 2;

  const position = (lo + hi) / 2;
  const gap      = hi - lo;

  return { position, needsRenorm: gap < MIN_GAP };
}

/**
 * Produce evenly-spaced positions for `count` items.
 * Used during renormalisation.
 *
 * @param {number} count
 * @returns {number[]}
 */
export function evenlySpaced(count) {
  return Array.from({ length: count }, (_, i) => (i + 1) * INITIAL_GAP);
}
