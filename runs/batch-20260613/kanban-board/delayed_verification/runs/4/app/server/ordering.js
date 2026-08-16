/**
 * Ordering utilities for fractional-position Kanban cards.
 *
 * Strategy
 * --------
 * Each card has a DOUBLE PRECISION `position` value within its column.
 * Inserting between two cards uses the midpoint of their positions.
 *
 * Collision / precision exhaustion
 * ---------------------------------
 * If the gap between two adjacent positions is smaller than MIN_GAP we
 * renormalize the entire column by spreading cards evenly with STEP spacing,
 * then broadcast the corrected order.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

/** Minimum gap before we consider positions "exhausted" */
const MIN_GAP = 1e-9;
/** Starting position for the first card in a column */
export const INITIAL_POSITION = 1000;
/** Spacing used when renormalizing */
const STEP = 1000;

/**
 * Compute a position value that places a card between `afterPos` and `beforePos`.
 *
 * @param {number|null} afterPos  - position of the card that will come before the new one (or null)
 * @param {number|null} beforePos - position of the card that will come after the new one (or null)
 * @returns {number}
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return INITIAL_POSITION;
  if (afterPos == null) return beforePos - STEP;
  if (beforePos == null) return afterPos + STEP;
  return (afterPos + beforePos) / 2;
}

/**
 * Check whether the column needs renormalization after inserting/moving a card.
 *
 * Checks two conditions:
 *   1. The gap between the new position and its intended neighbours is too small
 *      (fractional precision exhaustion).
 *   2. Any two cards in the column share the same position (collision), which
 *      can happen when multiple cards are moved to an empty column concurrently.
 *
 * @param {string}      columnId    - column to inspect (after the move is committed)
 * @param {string}      movedCardId - the card that was just moved (to exclude from gap check)
 * @param {number|null} afterPos
 * @param {number|null} beforePos
 * @param {number}      newPosition
 * @returns {Promise<boolean>}
 */
export async function needsRenormalization(columnId, movedCardId, afterPos, beforePos, newPosition) {
  // 1. Precision exhaustion check against intended neighbours
  if (afterPos != null && Math.abs(newPosition - afterPos) < MIN_GAP) return true;
  if (beforePos != null && Math.abs(beforePos - newPosition) < MIN_GAP) return true;

  // 2. Collision check: look for any duplicate positions in the column
  const db = getDb();
  const { rows } = await db.query(
    `SELECT position, COUNT(*) AS cnt
       FROM cards
      WHERE column_id = $1
      GROUP BY position
     HAVING COUNT(*) > 1
      LIMIT 1`,
    [columnId]
  );
  if (rows.length > 0) return true;

  return false;
}

/**
 * Renormalize all card positions in a column, spreading them evenly with STEP
 * spacing.
 *
 * After renormalization, broadcasts a `column-reordered` event so all clients
 * can reconcile.
 *
 * @param {string} columnId
 * @returns {Promise<Array<{id:string, position:number}>>} updated card stubs
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();

  // Fetch current order (ties broken by id for determinism)
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );

  // Assign evenly-spaced positions
  const updates = rows.map((r, i) => ({ id: r.id, position: (i + 1) * STEP }));

  for (const { id, position } of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
  }

  console.log(`[ordering] Renormalized column ${columnId} (${updates.length} cards).`);

  // Fetch full card data for broadcast
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      WHERE column_id = $1
      ORDER BY position ASC`,
    [columnId]
  );

  broadcast('column-reordered', { columnId, cards });

  return updates;
}

/**
 * Resolve `beforeId` / `afterId` card references to their current positions.
 *
 * @param {string|null} beforeId - id of the card that should come AFTER the moved card
 * @param {string|null} afterId  - id of the card that should come BEFORE the moved card
 * @returns {Promise<{afterPos: number|null, beforePos: number|null}>}
 */
export async function resolveNeighbourPositions(beforeId, afterId) {
  const db = getDb();
  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
    if (rows.length) afterPos = rows[0].position;
  }
  if (beforeId) {
    const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
    if (rows.length) beforePos = rows[0].position;
  }

  return { afterPos, beforePos };
}
