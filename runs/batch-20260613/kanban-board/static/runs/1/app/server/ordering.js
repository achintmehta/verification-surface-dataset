/**
 * Fractional-position ordering helpers.
 *
 * Each card carries a DOUBLE PRECISION `position` within its column.
 * Inserting between two cards uses the midpoint of their positions.
 *
 * Collision / precision-exhaustion detection:
 *   If the gap between two adjacent positions is smaller than MIN_GAP we
 *   renormalise the entire column by spreading cards evenly with STEP spacing.
 */

import { db } from './db.js';

/** Minimum gap before we consider positions "collided" and renormalise. */
const MIN_GAP = 1e-9;

/** Spacing used when renormalising a column. */
const STEP = 1000;

/**
 * Compute the position for a card being inserted between `afterId` and
 * `beforeId` inside `columnId`.
 *
 * Rules:
 *  - If both are null  → append to end of column.
 *  - If afterId only   → insert after that card (between it and the next).
 *  - If beforeId only  → insert before that card (between it and the prev).
 *  - If both provided  → midpoint between the two.
 *
 * Returns `{ position, needsRenorm }`.
 * When `needsRenorm` is true the caller must renormalise the column AFTER
 * persisting the card at the returned position.
 *
 * @param {string}      columnId
 * @param {string|null} afterId   – card that will be immediately above the new position
 * @param {string|null} beforeId  – card that will be immediately below the new position
 * @returns {Promise<{ position: number, needsRenorm: boolean }>}
 */
export async function computePosition(columnId, afterId, beforeId) {
  // Fetch all cards in the column ordered by position so we can look up
  // neighbours even when only one anchor is supplied.
  const { rows } = await db.query(
    `SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position`,
    [columnId]
  );

  /** @type {Map<string, number>} */
  const posMap = new Map(rows.map((r) => [r.id, r.position]));

  let low = null;   // position of the card immediately above
  let high = null;  // position of the card immediately below

  if (afterId && beforeId) {
    low  = posMap.get(afterId)  ?? null;
    high = posMap.get(beforeId) ?? null;
  } else if (afterId) {
    low = posMap.get(afterId) ?? null;
    // Find the card that comes after `afterId` in the sorted list.
    const idx = rows.findIndex((r) => r.id === afterId);
    if (idx !== -1 && idx + 1 < rows.length) {
      high = rows[idx + 1].position;
    }
  } else if (beforeId) {
    high = posMap.get(beforeId) ?? null;
    // Find the card that comes before `beforeId` in the sorted list.
    const idx = rows.findIndex((r) => r.id === beforeId);
    if (idx > 0) {
      low = rows[idx - 1].position;
    }
  }

  let position;

  if (low === null && high === null) {
    // Empty column or append to end.
    const maxPos = rows.length > 0 ? rows[rows.length - 1].position : 0;
    position = maxPos + STEP;
  } else if (low === null) {
    // Insert before the first card.
    position = high - STEP / 2;
  } else if (high === null) {
    // Insert after the last card.
    position = low + STEP;
  } else {
    // Midpoint between the two anchors.
    position = (low + high) / 2;
  }

  const needsRenorm = high !== null && low !== null && (high - low) < MIN_GAP * 2;

  return { position, needsRenorm };
}

/**
 * Renormalise all card positions in a column by spreading them evenly.
 * Returns the updated list of cards `{ id, position }` so the caller can
 * broadcast the corrected order.
 *
 * Must be called INSIDE a transaction (the caller owns the transaction).
 *
 * @param {string} columnId
 * @returns {Promise<Array<{ id: string, position: number }>>}
 */
export async function renormalizeColumn(columnId) {
  const { rows } = await db.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position`,
    [columnId]
  );

  const updates = rows.map((r, i) => ({ id: r.id, position: (i + 1) * STEP }));

  for (const { id, position } of updates) {
    await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [position, id]);
  }

  console.log(`[ordering] Renormalised ${updates.length} cards in column "${columnId}"`);
  return updates;
}
