/**
 * Fractional-position ordering helpers.
 *
 * Cards carry a DOUBLE PRECISION `position` value.  Inserting between two
 * neighbours uses the midpoint.  When the gap becomes too small (< MIN_GAP)
 * we renormalise the whole column so positions are evenly spaced again.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

const STEP    = 1000;   // initial spacing between cards
const MIN_GAP = 1e-9;   // below this we must renormalise

/**
 * Compute a position for a card being inserted/moved within a column.
 *
 * Parameters:
 *   columnId  – target column
 *   afterId   – the card that will be immediately ABOVE  the new position (or null)
 *   beforeId  – the card that will be immediately BELOW  the new position (or null)
 *   excludeId – (optional) id of the card being moved; exclude it from neighbour lookup
 *               so a card moving within its own column doesn't see itself as a neighbour
 *
 * Returns { position, needsRenorm }
 */
export async function computePosition(columnId, afterId, beforeId, excludeId = null) {
  const db = getDb();

  // Fetch all current cards in the column (excluding the card being moved if any)
  // sorted by position so we can find true neighbours.
  const { rows: allCards } = await db.query(
    `SELECT id, position FROM cards
      WHERE column_id = $1 ${excludeId ? 'AND id != $2' : ''}
      ORDER BY position ASC`,
    excludeId ? [columnId, excludeId] : [columnId]
  );

  // Build a map for quick lookup
  const posMap = {};
  for (const c of allCards) posMap[c.id] = c.position;

  let afterPos  = afterId  ? (posMap[afterId]  ?? null) : null;
  let beforePos = beforeId ? (posMap[beforeId] ?? null) : null;

  // If afterId/beforeId are not in this column (e.g. cross-column move with stale ids),
  // fall back to appending at the end.
  if (afterId && afterPos === null) afterPos = null;
  if (beforeId && beforePos === null) beforePos = null;

  // Case 1: No neighbours specified → append at end
  if (afterPos === null && beforePos === null) {
    const mx = allCards.length > 0 ? allCards[allCards.length - 1].position : 0;
    return { position: mx + STEP, needsRenorm: false };
  }

  // Case 2: Only beforeId → insert before the first card
  if (afterPos === null) {
    // Find the card that comes before beforeId in the sorted list
    const beforeIdx = allCards.findIndex(c => c.id === beforeId);
    if (beforeIdx <= 0) {
      // beforeId is the first card; place before it
      return { position: beforePos - STEP, needsRenorm: false };
    }
    // There's a card before it; use midpoint
    const prevPos = allCards[beforeIdx - 1].position;
    const mid = (prevPos + beforePos) / 2;
    const gap = beforePos - prevPos;
    return { position: mid, needsRenorm: gap < MIN_GAP };
  }

  // Case 3: Only afterId → append after the last card
  if (beforePos === null) {
    // Find the card that comes after afterId in the sorted list
    const afterIdx = allCards.findIndex(c => c.id === afterId);
    if (afterIdx === -1 || afterIdx === allCards.length - 1) {
      // afterId is the last card; place after it
      return { position: afterPos + STEP, needsRenorm: false };
    }
    // There's a card after it; use midpoint
    const nextPos = allCards[afterIdx + 1].position;
    const mid = (afterPos + nextPos) / 2;
    const gap = nextPos - afterPos;
    return { position: mid, needsRenorm: gap < MIN_GAP };
  }

  // Case 4: Both neighbours specified → midpoint
  const mid = (afterPos + beforePos) / 2;
  const gap = Math.abs(beforePos - afterPos);
  return { position: mid, needsRenorm: gap < MIN_GAP };
}

/**
 * Renormalise all card positions in a column so they are evenly spaced by
 * STEP, then broadcast a `column-reorder` event so every client reconciles.
 */
export async function renormaliseColumn(columnId) {
  const db = getDb();

  // Fetch current order
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  // Assign fresh positions inside a transaction
  await db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i++) {
      await db.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [(i + 1) * STEP, rows[i].id]
      );
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  // Fetch the freshly ordered cards and broadcast
  const { rows: cards } = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  broadcast('column-reorder', { columnId, cards });
  console.log(`[ordering] renormalised column ${columnId} (${rows.length} cards)`);
}
