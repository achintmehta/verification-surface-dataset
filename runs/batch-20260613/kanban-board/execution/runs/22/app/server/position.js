// Position utilities for fractional indexing

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // Below this we renormalize

/**
 * Compute a position value between two existing positions.
 * If afterPos is null, we're inserting at the start.
 * If beforePos is null, we're inserting at the end.
 * If both are null, use the default gap.
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    return POSITION_GAP;
  }
  if (afterPos == null) {
    // Insert before the first item
    return beforePos / 2;
  }
  if (beforePos == null) {
    // Insert after the last item
    return afterPos + POSITION_GAP;
  }
  return (afterPos + beforePos) / 2;
}

/**
 * Check if positions in a column need renormalization.
 * Returns true if any adjacent pair is too close.
 */
export function needsRenormalization(positions) {
  if (positions.length < 2) return false;
  for (let i = 1; i < positions.length; i++) {
    if (Math.abs(positions[i] - positions[i - 1]) < MIN_GAP) {
      return true;
    }
  }
  return false;
}

/**
 * Generate new evenly-spaced positions for a column.
 */
export function renormalize(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push((i + 1) * POSITION_GAP);
  }
  return positions;
}

export { POSITION_GAP, MIN_GAP };
