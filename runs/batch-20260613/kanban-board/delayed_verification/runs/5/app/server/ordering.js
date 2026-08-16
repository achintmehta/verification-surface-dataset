/**
 * ordering.js – Fractional position helpers.
 *
 * Cards within a column are ordered by a DOUBLE PRECISION `position` value.
 * Inserting between two cards uses the midpoint of their positions.  When
 * positions get too close (within EPSILON) or a column needs a full reset we
 * renormalise by spreading cards evenly with GAP spacing.
 */

/** Minimum gap between two positions before we consider them a collision. */
export const EPSILON = 1e-9;

/** Spacing used when seeding or renormalising a column. */
export const GAP = 1000;

/**
 * Compute a position value that places a card between `before` and `after`.
 *
 * - `before` is the position of the card that will come immediately before the
 *   new card (or null / undefined if inserting at the start).
 * - `after`  is the position of the card that will come immediately after the
 *   new card (or null / undefined if inserting at the end).
 *
 * Returns { position, needsRenorm } where `needsRenorm` is true when the
 * computed gap is dangerously small and the caller should renormalise the
 * column.
 *
 * @param {number|null|undefined} before  position of the preceding card
 * @param {number|null|undefined} after   position of the following card
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(before, after) {
  const lo = before ?? 0;
  const hi = after  ?? (lo + GAP * 2);

  const position = (lo + hi) / 2;
  const gap      = hi - lo;
  const needsRenorm = gap < EPSILON;

  return { position, needsRenorm };
}

/**
 * Compute the position for a card appended to the end of a column.
 *
 * @param {number|null|undefined} lastPosition  position of the current last card
 * @returns {number}
 */
export function appendPosition(lastPosition) {
  return (lastPosition ?? 0) + GAP;
}

/**
 * Renormalise the positions of all cards in a column so they are evenly
 * spaced by GAP.  Returns an array of { id, position } updates.
 *
 * @param {Array<{ id: string }>} orderedCards  cards already sorted by position
 * @returns {Array<{ id: string, position: number }>}
 */
export function renormalise(orderedCards) {
  return orderedCards.map((card, i) => ({
    id:       card.id,
    position: (i + 1) * GAP,
  }));
}
