/**
 * Fractional-position ordering helpers.
 *
 * Cards within a column are ordered by a DOUBLE PRECISION `position` value.
 * Inserting between two cards uses the midpoint of their positions.
 *
 * Collision / precision-exhaustion detection:
 *   If the gap between two adjacent positions is smaller than MIN_GAP we
 *   renormalize the entire column by spreading cards evenly with STEP spacing.
 */

import { getDb } from './db.js';
import { broadcast } from './sse.js';

/** Minimum acceptable gap between two adjacent positions before renormalization */
const MIN_GAP = 1e-9;

/** Spacing used when renormalizing a column */
const STEP = 1000;

/**
 * Compute the position for a card being inserted between `afterId` and `beforeId`
 * inside `columnId`.
 *
 * Rules:
 *  - afterId  = the card that will be immediately ABOVE  the new position (or null → top)
 *  - beforeId = the card that will be immediately BELOW the new position (or null → bottom)
 *
 * Returns { position, needsRenorm } where needsRenorm signals the caller should
 * renormalize the column after the insert/update.
 *
 * @param {string}      columnId
 * @param {string|null} afterId   - card id above the target slot (null = insert at top)
 * @param {string|null} beforeId  - card id below the target slot (null = insert at bottom)
 * @param {string|null} excludeId - card being moved (exclude from boundary lookup)
 */
export async function computePosition(columnId, afterId, beforeId, excludeId = null) {
  const db = getDb();

  // Fetch the bounding positions
  let above = null;
  let below = null;

  if (afterId) {
    const r = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [afterId, columnId]
    );
    if (r.rows.length) above = r.rows[0].position;
  }

  if (beforeId) {
    const r = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [beforeId, columnId]
    );
    if (r.rows.length) below = r.rows[0].position;
  }

  // If neither boundary was found, derive from the actual column order
  if (above === null && below === null) {
    // Append to end
    const r = await db.query(
      `SELECT position FROM cards
       WHERE column_id = $1 ${excludeId ? 'AND id != $2' : ''}
       ORDER BY position DESC LIMIT 1`,
      excludeId ? [columnId, excludeId] : [columnId]
    );
    const maxPos = r.rows.length ? r.rows[0].position : 0;
    return { position: maxPos + STEP, needsRenorm: false };
  }

  if (above === null) {
    // Insert before the first card
    return { position: below - STEP, needsRenorm: false };
  }

  if (below === null) {
    // Insert after the last card
    return { position: above + STEP, needsRenorm: false };
  }

  // Midpoint between the two neighbours
  const mid = (above + below) / 2;
  const gap = below - above;
  return { position: mid, needsRenorm: gap < MIN_GAP * 2 };
}

/**
 * Renormalize all card positions in a column, spreading them evenly.
 * Broadcasts a `column-reordered` event so all clients can reconcile.
 *
 * @param {string} columnId
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();

  // Fetch current order
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  if (rows.length === 0) return;

  // Assign evenly-spaced positions inside a transaction
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [(i + 1) * STEP, rows[i].id]
      );
    }
  });

  // Fetch the updated cards to broadcast
  const updated = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards WHERE column_id = $1 ORDER BY position ASC`,
    [columnId]
  );

  broadcast('column-reordered', {
    columnId,
    cards: updated.rows,
  });
}
