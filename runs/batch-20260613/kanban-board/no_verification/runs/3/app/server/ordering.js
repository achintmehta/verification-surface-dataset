/**
 * Fractional-position ordering helpers.
 *
 * Each card stores a DOUBLE PRECISION `position` within its column.
 * Inserting between two cards uses the midpoint of their positions.
 *
 * Collision / precision exhaustion detection
 * ──────────────────────────────────────────
 * If the computed midpoint equals either neighbour (i.e. there is no
 * representable float between them) we renormalise the entire column by
 * spreading cards evenly across [1000, 1000*N] with a gap of 1000.
 *
 * The caller is responsible for persisting renormalised positions and
 * broadcasting the corrected order.
 */

/** Gap used when appending to the end of a column or during renormalisation. */
export const POSITION_GAP = 1000;

/**
 * Compute a position value that places a card between `before` and `after`.
 *
 * @param {number|null} before  – position of the card that will come before the
 *                                new card (null → insert at the very beginning)
 * @param {number|null} after   – position of the card that will come after the
 *                                new card (null → insert at the very end)
 * @param {number}      maxPos  – current maximum position in the column
 *                                (used when after is null)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(before, after, maxPos) {
  let position;

  if (before === null && after === null) {
    // Empty column or no neighbours – start at gap.
    position = POSITION_GAP;
  } else if (before === null) {
    // Insert before the first card.
    position = after / 2;
  } else if (after === null) {
    // Append after the last card.
    position = before + POSITION_GAP;
  } else {
    // Midpoint between neighbours.
    position = (before + after) / 2;
  }

  // Detect precision exhaustion: if the computed value equals a neighbour
  // there is no representable float between them.
  const needsRenorm =
    position === before ||
    position === after ||
    !Number.isFinite(position);

  return { position, needsRenorm };
}

/**
 * Produce renormalised positions for an ordered list of card ids.
 * Returns an array of { id, position } objects with evenly-spaced positions.
 *
 * @param {Array<{ id: string }>} orderedCards
 * @returns {Array<{ id: string, position: number }>}
 */
export function renormalise(orderedCards) {
  return orderedCards.map((card, index) => ({
    id: card.id,
    position: (index + 1) * POSITION_GAP,
  }));
}
