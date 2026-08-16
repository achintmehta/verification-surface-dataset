// Fractional ordering utilities

const MIN_GAP = 0.0001; // Minimum acceptable gap between positions
const RENORM_BASE = 1000; // Base spacing when renormalizing
const RENORM_STEP = 1000; // Step between positions when renormalizing

/**
 * Compute a position between two existing positions.
 * Returns null if the gap is too small (needs renormalization).
 */
function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // First card in column
    return RENORM_BASE;
  }
  if (afterPos == null) {
    // Insert at the beginning (before the first card)
    return beforePos / 2;
  }
  if (beforePos == null) {
    // Insert at the end (after the last card)
    return afterPos + RENORM_STEP;
  }
  // Insert between two cards
  const mid = (afterPos + beforePos) / 2;
  const gap = beforePos - afterPos;
  if (gap < MIN_GAP) {
    return null; // Signal that renormalization is needed
  }
  return mid;
}

/**
 * Check if a position collides with or is too close to existing positions.
 */
function needsRenormalization(positions, newPos) {
  for (const pos of positions) {
    if (Math.abs(pos - newPos) < MIN_GAP) {
      return true;
    }
  }
  return false;
}

/**
 * Compute renormalized positions for a list of card IDs in order.
 * Returns an array of { id, position } objects.
 */
function renormalize(cardIds) {
  return cardIds.map((id, index) => ({
    id,
    position: RENORM_BASE + index * RENORM_STEP
  }));
}

module.exports = { computePosition, needsRenormalization, renormalize, MIN_GAP, RENORM_BASE, RENORM_STEP };
