/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION floats.  We use a simple midpoint strategy:
 *   - Insert at end   → max(existing) + 1000
 *   - Insert at start → min(existing) / 2   (or 500 if column is empty)
 *   - Insert between  → (prev + next) / 2
 *
 * Collision / precision exhaustion is detected when the gap between two
 * adjacent positions is smaller than MIN_GAP.  In that case we renormalise
 * the entire column by spacing cards 1000 apart.
 */

const MIN_GAP = 1e-9;
const STEP    = 1000;

/**
 * Compute a new position for a card being inserted between `after` and `before`.
 *
 * @param {number|null} afterPos  - position of the card that will be above the new one (null = insert at top)
 * @param {number|null} beforePos - position of the card that will be below the new one (null = insert at bottom)
 * @param {number[]}    existing  - sorted positions of all cards currently in the column (used for end-insert)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(afterPos, beforePos, existing) {
  let position;

  if (afterPos === null && beforePos === null) {
    // Insert at end (or into empty column)
    const maxPos = existing.length > 0 ? Math.max(...existing) : 0;
    position = maxPos + STEP;
  } else if (afterPos === null) {
    // Insert before the first card
    position = beforePos / 2;
  } else if (beforePos === null) {
    // Insert after the last card
    position = afterPos + STEP;
  } else {
    // Insert between two cards
    position = (afterPos + beforePos) / 2;
  }

  // Check whether the gap is dangerously small
  const needsRenorm =
    (afterPos !== null && Math.abs(position - afterPos) < MIN_GAP) ||
    (beforePos !== null && Math.abs(beforePos - position) < MIN_GAP);

  return { position, needsRenorm };
}

/**
 * Produce renormalised positions for a list of card ids (already sorted by
 * their current position).
 *
 * @param {string[]} orderedIds
 * @returns {{ id: string, position: number }[]}
 */
export function renormalizePositions(orderedIds) {
  return orderedIds.map((id, i) => ({ id, position: (i + 1) * STEP }));
}
