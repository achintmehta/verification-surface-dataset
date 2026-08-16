// Fractional position ordering helpers.
//
// Cards within a column carry a DOUBLE PRECISION `position`. Inserting a card
// between two others picks a value between their positions. To guard against
// precision exhaustion or collisions, we detect "tight" gaps and renormalize
// the whole column to evenly spaced integers when needed.

// Spacing used when renormalizing a column.
export const STEP = 1000;

// Minimum gap allowed before we consider positions exhausted and renormalize.
const MIN_GAP = 1e-6;

/**
 * Compute a target position between two neighbours.
 *
 * @param {number|null} afterPos  position of the card that should be ABOVE the moved card (smaller position)
 * @param {number|null} beforePos position of the card that should be BELOW the moved card (larger position)
 * @returns {{ position: number, needsRenormalize: boolean }}
 */
export function computePosition(afterPos, beforePos) {
  const hasAfter = afterPos !== null && afterPos !== undefined;
  const hasBefore = beforePos !== null && beforePos !== undefined;

  // Empty column / no neighbours: place in the middle of the space.
  if (!hasAfter && !hasBefore) {
    return { position: STEP, needsRenormalize: false };
  }

  // Insert at top (before the first card).
  if (!hasAfter && hasBefore) {
    return { position: beforePos - STEP, needsRenormalize: false };
  }

  // Insert at bottom (after the last card).
  if (hasAfter && !hasBefore) {
    return { position: afterPos + STEP, needsRenormalize: false };
  }

  // Insert between two cards.
  const gap = beforePos - afterPos;
  if (gap <= MIN_GAP) {
    // Positions are too close (or inverted): force a renormalize.
    return { position: (afterPos + beforePos) / 2, needsRenormalize: true };
  }
  return { position: afterPos + gap / 2, needsRenormalize: false };
}
