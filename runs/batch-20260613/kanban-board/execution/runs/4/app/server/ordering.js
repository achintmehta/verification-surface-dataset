/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION floats.  We use a base of 1000 so that
 * initial positions are 1000, 2000, 3000 … and there is plenty of room
 * between them.  When two positions are so close that the midpoint equals
 * one of them (float precision exhausted) we renormalise the whole column.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

const BASE = 1000;

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * Rules:
 *   - If both are null  → append at end (max + BASE)
 *   - If before is null → prepend (after / 2)
 *   - If after  is null → append  (before + BASE)
 *   - Otherwise         → midpoint
 *
 * Returns { position, needsRenorm } where needsRenorm is true when the
 * midpoint collapsed to one of its neighbours.
 */
export function computePosition(beforePos, afterPos) {
  let position;

  const hasBefore = beforePos !== null && beforePos !== undefined;
  const hasAfter  = afterPos  !== null && afterPos  !== undefined;

  if (!hasBefore && !hasAfter) {
    position = BASE;
  } else if (!hasBefore) {
    // inserting before the first card
    position = afterPos / 2;
  } else if (!hasAfter) {
    // inserting after the last card
    position = beforePos + BASE;
  } else {
    position = (beforePos + afterPos) / 2;
  }

  const needsRenorm =
    position === beforePos || position === afterPos;

  return { position, needsRenorm };
}

/**
 * Re-index all cards in a column with evenly-spaced positions (multiples of
 * BASE), then broadcast the corrected order so every client converges.
 *
 * Must be called AFTER the triggering card has already been written to the DB
 * so the renorm includes it.
 *
 * @param {string} columnId
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();

  // Fetch current order
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC',
    [columnId]
  );

  // Assign new evenly-spaced positions inside a transaction
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [(i + 1) * BASE, rows[i].id]
      );
    }
  });

  // Fetch the updated cards and broadcast
  const { rows: updated } = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  broadcast('column-reorder', { columnId, cards: updated });
  console.log(`[ordering] renormalized column ${columnId} (${rows.length} cards)`);
}

/**
 * Resolve beforeId / afterId to actual position values.
 *
 * @param {string|null} beforeId  - card that will be immediately ABOVE the new position
 * @param {string|null} afterId   - card that will be immediately BELOW the new position
 * @param {string}      columnId  - target column
 * @param {string}      [excludeId] - card being moved (exclude from neighbour lookup)
 * @returns {{ beforePos: number|null, afterPos: number|null }}
 */
export async function resolveNeighbourPositions(beforeId, afterId, columnId, excludeId) {
  const db = getDb();

  let beforePos = null;
  let afterPos  = null;

  if (beforeId && beforeId !== excludeId) {
    const { rows } = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [beforeId, columnId]
    );
    if (rows.length) beforePos = rows[0].position;
  }

  if (afterId && afterId !== excludeId) {
    const { rows } = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [afterId, columnId]
    );
    if (rows.length) afterPos = rows[0].position;
  }

  // If neither neighbour was found in the column, fall back to appending
  return { beforePos, afterPos };
}

/**
 * Get the maximum position in a column (or 0 if empty).
 */
export async function getMaxPosition(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  return rows[0].max;
}
