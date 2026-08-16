/**
 * Fractional position ordering helpers.
 *
 * Each card carries a numeric `position` within its column. To insert a card
 * between two neighbours we pick a value strictly between their positions.
 * This avoids re-indexing an entire column on every move.
 *
 * When two positions are too close to safely split (precision exhaustion) or a
 * collision is detected, the caller renormalizes the affected column.
 */

// Default spacing used when appending to the end of a column.
export const POSITION_STEP = 1000;

// Minimum gap below which we consider fractional positions "exhausted".
export const MIN_GAP = 1e-6;

/**
 * Compute a position strictly between `after` and `before`.
 *
 * @param {number|null} after  - position of the card that should precede the
 *                               inserted card (the lower bound). null = start.
 * @param {number|null} before - position of the card that should follow the
 *                               inserted card (the upper bound). null = end.
 * @returns {{ position: number|null }} - computed position, or null when the
 *          gap is exhausted and the column must be renormalized.
 */
export function computePosition(after, before) {
  const hasAfter = after !== null && after !== undefined;
  const hasBefore = before !== null && before !== undefined;

  if (!hasAfter && !hasBefore) {
    // Empty column.
    return { position: POSITION_STEP };
  }
  if (!hasAfter && hasBefore) {
    // Insert at the very start.
    return { position: before - POSITION_STEP };
  }
  if (hasAfter && !hasBefore) {
    // Insert at the very end.
    return { position: after + POSITION_STEP };
  }

  // Insert in the middle.
  const gap = before - after;
  if (gap <= MIN_GAP) {
    // Precision exhausted / collision; signal a renormalization.
    return { position: null };
  }
  return { position: after + gap / 2 };
}
