/**
 * Fractional-position ordering helpers.
 *
 * Positions are stored as DOUBLE PRECISION (float8) in PGLite.
 * We use a simple midpoint strategy and renormalise when precision is exhausted.
 */

const MIN_GAP = 1e-9; // below this gap we renormalise

/**
 * Compute a position for a card inserted between `before` and `after`.
 *
 * @param {number|null} afterPos  – position of the card that will be above the new one (null = top)
 * @param {number|null} beforePos – position of the card that will be below the new one (null = bottom)
 * @param {number}      maxPos    – current maximum position in the column (used when appending)
 * @returns {number}
 */
export function computePosition(afterPos, beforePos, maxPos) {
  if (afterPos === null && beforePos === null) {
    // Only card in column
    return 1000;
  }
  if (afterPos === null) {
    // Insert at the very top
    return beforePos / 2;
  }
  if (beforePos === null) {
    // Append at the bottom
    return afterPos + 1000;
  }
  // Insert between two cards
  return (afterPos + beforePos) / 2;
}

/**
 * Check whether the gap between two adjacent positions is too small.
 */
export function needsRenormalisation(positions) {
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < MIN_GAP) return true;
  }
  return false;
}

/**
 * Produce a fresh set of evenly-spaced positions for `count` cards.
 * Returns an array of numbers of length `count`.
 */
export function renormalisedPositions(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push((i + 1) * 1000);
  }
  return positions;
}
