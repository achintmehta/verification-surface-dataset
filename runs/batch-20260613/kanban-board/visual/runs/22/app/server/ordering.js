// Fractional position ordering utilities

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // Below this gap we renormalize

/**
 * Compute the new position for a card being inserted between two neighbors.
 * @param {number|null} afterPos  - position of the card above (after which we insert), or null if inserting at top
 * @param {number|null} beforePos - position of the card below (before which we insert), or null if inserting at bottom
 * @returns {number} computed position
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // Only card in the column
    return POSITION_GAP;
  }
  if (afterPos == null) {
    // Insert at the top (before the first card)
    return beforePos - POSITION_GAP;
  }
  if (beforePos == null) {
    // Insert at the bottom (after the last card)
    return afterPos + POSITION_GAP;
  }
  // Insert between two cards
  return (afterPos + beforePos) / 2;
}

/**
 * Check if a column needs renormalization (positions too close together).
 * @param {Array<{id: string, position: number}>} cards - cards sorted by position
 * @returns {boolean}
 */
export function needsRenormalization(cards) {
  if (cards.length < 2) return false;
  for (let i = 1; i < cards.length; i++) {
    const gap = Math.abs(cards[i].position - cards[i - 1].position);
    if (gap < MIN_GAP) return true;
  }
  return false;
}

/**
 * Generate renormalized positions for cards in a column.
 * @param {Array<{id: string, position: number}>} cards - cards sorted by position
 * @returns {Array<{id: string, position: number}>} cards with new positions
 */
export function renormalize(cards) {
  return cards.map((card, index) => ({
    ...card,
    position: (index + 1) * POSITION_GAP,
  }));
}

export { POSITION_GAP };
