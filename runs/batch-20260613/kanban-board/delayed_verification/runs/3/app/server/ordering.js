/**
 * Ordering utilities for fractional-position Kanban cards.
 *
 * Strategy
 * --------
 * Each card has a DOUBLE PRECISION `position` value.  Inserting between two
 * cards uses the midpoint of their positions.  When the gap shrinks below
 * MIN_GAP we renormalise the entire column by spreading cards evenly with
 * STEP spacing, then return the renormalised list so the caller can broadcast
 * the corrected order.
 */

const STEP = 1000;     // spacing used when appending / renormalising
const MIN_GAP = 1e-9;  // minimum acceptable gap before renormalisation

/**
 * Compute the position for a card being inserted between `after` and `before`.
 *
 * @param {number|null} afterPos   - position of the card immediately ABOVE the
 *                                   insertion point (null = insert at top)
 * @param {number|null} beforePos  - position of the card immediately BELOW the
 *                                   insertion point (null = insert at bottom)
 * @param {number}      maxPos     - current maximum position in the target column
 *                                   (0 if the column is empty)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(afterPos, beforePos, maxPos) {
  let position;

  if (afterPos === null && beforePos === null) {
    // No neighbours supplied: append at the end (or start if column is empty)
    position = maxPos + STEP;
  } else if (afterPos === null) {
    // Insert before the first card
    position = beforePos / 2;
  } else if (beforePos === null) {
    // Append after the last card
    position = maxPos + STEP;
  } else {
    // Insert between two cards
    position = (afterPos + beforePos) / 2;
  }

  const gap =
    afterPos !== null && beforePos !== null
      ? Math.abs(beforePos - afterPos)
      : Infinity;

  return { position, needsRenorm: gap < MIN_GAP };
}

/**
 * Renormalise all cards in a column by assigning evenly-spaced positions.
 *
 * @param {object[]} cards  - array of card rows ordered by current position
 * @returns {object[]}      - same cards with updated `position` values
 */
export function renormalise(cards) {
  return cards.map((card, i) => ({
    ...card,
    position: (i + 1) * STEP,
  }));
}
