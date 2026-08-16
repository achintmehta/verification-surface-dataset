const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // Below this, renormalize

/**
 * Compute a new position between two existing positions.
 * If afterPos is null, it means top of list (before everything).
 * If beforePos is null, it means bottom of list (after everything).
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // Only card in the column
    return POSITION_GAP;
  }
  if (afterPos == null) {
    // Insert at the top (before the first card)
    return beforePos / 2;
  }
  if (beforePos == null) {
    // Insert at the bottom (after the last card)
    return afterPos + POSITION_GAP;
  }
  // Insert between two cards
  return (afterPos + beforePos) / 2;
}

/**
 * Check if a position value causes a collision or precision issue,
 * and renormalize the column if needed.
 * @param {string} movedCardId - The card ID that was just moved (excluded from collision check)
 */
export async function renormalizeIfNeeded(db, columnId, newPosition, afterPos, beforePos, movedCardId) {
  let needsRenormalize = false;

  // Check if the gap is too small
  if (afterPos != null && Math.abs(newPosition - afterPos) < MIN_GAP) {
    needsRenormalize = true;
  }
  if (beforePos != null && Math.abs(beforePos - newPosition) < MIN_GAP) {
    needsRenormalize = true;
  }

  // Check for exact collision (exclude the card we just moved)
  const collision = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
    [columnId, newPosition, movedCardId]
  );
  if (collision.rows.length > 0) {
    needsRenormalize = true;
  }

  if (needsRenormalize) {
    return await renormalizeColumn(db, columnId);
  }

  return null;
}

/**
 * Renormalize all card positions in a column to evenly spaced values.
 * Returns the updated cards for broadcasting.
 */
export async function renormalizeColumn(db, columnId) {
  const cards = await db.query(
    'SELECT id, text, column_id, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  if (cards.rows.length === 0) return null;

  const updatedCards = [];
  for (let i = 0; i < cards.rows.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards.rows[i].position !== newPos) {
      await db.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [newPos, cards.rows[i].id]
      );
      updatedCards.push({
        ...cards.rows[i],
        position: newPos,
      });
    } else {
      updatedCards.push(cards.rows[i]);
    }
  }

  return updatedCards;
}
