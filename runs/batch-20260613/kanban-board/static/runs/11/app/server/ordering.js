// Fractional position ordering helpers.
//
// Each card carries a numeric `position` within its column. To insert a card
// between two others we pick a value strictly between their positions. This
// avoids re-indexing an entire column on every move.
//
// We use a fixed gap (DEFAULT_GAP) when appending to the end of a column so
// there is always room to insert before the last element, and the midpoint
// when inserting between two known neighbours.

export const DEFAULT_GAP = 1024;

// Minimum allowed difference between two adjacent positions. If a computed gap
// is smaller than this we treat the column as exhausted and renormalize.
export const MIN_GAP = 1e-6;

/**
 * Compute a position strictly between `after` and `before`.
 *
 * `after`  = the position of the card that will sit immediately *above* the
 *            inserted card (i.e. the lower position value), or null if the card
 *            is being inserted at the very top.
 * `before` = the position of the card that will sit immediately *below* the
 *            inserted card (i.e. the higher position value), or null if the
 *            card is being inserted at the very bottom.
 *
 * Returns { position, needsRenormalize }. When the neighbours are too close to
 * fit a new value with enough precision, `needsRenormalize` is true and the
 * returned `position` is a best-effort midpoint (the caller should renormalize
 * the column afterwards).
 */
export function computePosition(after, before) {
  const hasAfter = after !== null && after !== undefined;
  const hasBefore = before !== null && before !== undefined;

  if (!hasAfter && !hasBefore) {
    // Empty column.
    return { position: DEFAULT_GAP, needsRenormalize: false };
  }

  if (!hasAfter && hasBefore) {
    // Insert at the top, before the first card.
    return { position: before / 2, needsRenormalize: before / 2 <= 0 };
  }

  if (hasAfter && !hasBefore) {
    // Append at the bottom, after the last card.
    return { position: after + DEFAULT_GAP, needsRenormalize: false };
  }

  // Insert between two cards.
  if (before <= after) {
    // Neighbours are out of order or equal: cannot fit a value, renormalize.
    return { position: (after + before) / 2, needsRenormalize: true };
  }

  const mid = (after + before) / 2;
  const needsRenormalize =
    before - after < MIN_GAP || mid <= after || mid >= before;
  return { position: mid, needsRenormalize };
}

/**
 * Produce evenly spaced positions for an ordered list of card ids.
 * Used when renormalizing a column.
 */
export function renormalizedPositions(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push((i + 1) * DEFAULT_GAP);
  }
  return positions;
}
