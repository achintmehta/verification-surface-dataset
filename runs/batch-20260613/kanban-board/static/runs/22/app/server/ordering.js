import { getDB } from './db.js';
import { broadcast } from './sse.js';

/**
 * The minimum gap between two positions before we consider renormalization.
 * With IEEE-754 doubles we have ~15 significant digits; using 1e-9 gives
 * plenty of room before precision loss.
 */
const MIN_GAP = 1e-9;

/** Base spacing when renormalizing a column. */
const RENORM_SPACING = 1000;

/**
 * Compute a position value between `before` and `after`.
 * - If both are null, return RENORM_SPACING (first card in column).
 * - If only `after` is null, return `before + RENORM_SPACING`.
 * - If only `before` is null, return `after / 2`.
 * - Otherwise, return the midpoint.
 *
 * @param {number | null} before - position of the card above (lower position)
 * @param {number | null} after  - position of the card below (higher position)
 * @returns {number}
 */
export function computePosition(before, after) {
  if (before == null && after == null) return RENORM_SPACING;
  if (before == null) return /** @type {number} */ (after) / 2;
  if (after == null) return before + RENORM_SPACING;
  return (before + after) / 2;
}

/**
 * Check whether a position gap is too small and, if so, renormalize the
 * entire column.  Returns `true` if renormalization occurred.
 *
 * A renormalization re-spaces all cards in the column to integer multiples of
 * RENORM_SPACING, broadcasts the corrected order, and returns the *new*
 * position of the card with `cardId`.
 *
 * @param {string} columnId
 * @param {string} cardId
 * @param {number} gapBefore - gap between this card and the one above (or Infinity)
 * @param {number} gapAfter  - gap between this card and the one below (or Infinity)
 * @returns {Promise<number | null>} the card's new position after renorm, or null if no renorm needed
 */
export async function renormalizeIfNeeded(columnId, cardId, gapBefore, gapAfter) {
  if (gapBefore >= MIN_GAP && gapAfter >= MIN_GAP) return null;

  const db = getDB();

  // Re-read all cards in order and re-space them
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );

  /** @type {Array<{id: string, position: number}>} */
  const updates = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * RENORM_SPACING;
    if (cards[i].position !== newPos) {
      updates.push({ id: cards[i].id, position: newPos });
    }
  }

  if (updates.length === 0) return null;

  // Apply updates in a single transaction
  await db.exec('BEGIN');
  for (const u of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [u.position, u.id]);
  }
  await db.exec('COMMIT');

  // Broadcast the full corrected column ordering
  const { rows: corrected } = await db.query(
    `SELECT c.id, c.column_id AS "columnId", c.text, c.position, c.created_at AS "createdAt"
     FROM cards c WHERE c.column_id = $1 ORDER BY c.position ASC`,
    [columnId],
  );

  broadcast('column_reorder', { columnId, cards: corrected });

  // Return the card's new position
  const target = corrected.find((c) => c.id === cardId);
  return target ? target.position : null;
}
