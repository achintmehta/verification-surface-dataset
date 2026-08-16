/**
 * Ordering utilities for fractional position arithmetic.
 *
 * Cards are ordered by a DOUBLE PRECISION `position` column.
 * Inserting between two cards uses the midpoint of their positions.
 * When positions get too close (collision / precision exhaustion),
 * we renormalize the entire column with evenly-spaced integers.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

/** Minimum gap between two positions before we consider renormalization. */
const MIN_GAP = 1e-9;

/** Spacing used when renormalizing a column. */
const RENORM_STEP = 1000;

/**
 * Compute a position value for a card being inserted between `afterPos`
 * and `beforePos`.  Either may be null (meaning "at the start" or "at the end").
 *
 * @param {number|null} afterPos  - position of the card that will come before the new one
 * @param {number|null} beforePos - position of the card that will come after the new one
 * @param {number}      maxPos    - current maximum position in the column (used for appending)
 * @returns {number}
 */
export function computePosition(afterPos, beforePos, maxPos) {
  if (afterPos === null && beforePos === null) {
    // Empty column or no neighbours specified → append
    return (maxPos ?? 0) + RENORM_STEP;
  }
  if (afterPos === null) {
    // Insert before the first card
    return beforePos - RENORM_STEP / 2;
  }
  if (beforePos === null) {
    // Insert after the last card
    return afterPos + RENORM_STEP;
  }
  // Insert between two cards
  return (afterPos + beforePos) / 2;
}

/**
 * Check whether the positions in a column need renormalization and, if so,
 * renormalize them, persist the changes, and broadcast the corrected order.
 *
 * This is called after every move/create that touches a column.
 *
 * @param {string} columnId
 */
export async function maybeRenormalize(columnId) {
  const db = getDb();

  // Fetch all cards in the column ordered by position
  const { rows } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  if (rows.length < 2) return; // Nothing to check

  // Detect whether any adjacent pair is too close
  let needsRenorm = false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].position - rows[i - 1].position < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return;

  console.log(`[ordering] renormalizing column ${columnId} (${rows.length} cards)`);

  // Assign evenly-spaced positions inside a transaction
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const newPos = (i + 1) * RENORM_STEP;
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [newPos, rows[i].id]
      );
    }
  });

  // Broadcast the renormalized column so all clients converge
  const { rows: updatedCards } = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  broadcast('renormalize', { columnId, cards: updatedCards });
}
