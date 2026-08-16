import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Spacing used when appending to the end of a column or renormalizing.
const POSITION_STEP = 1000;
// Minimum gap between two fractional positions before we consider the
// numeric precision exhausted and trigger a renormalization.
const MIN_GAP = 1e-6;

/**
 * Fetch the full board: ordered columns, each with its ordered cards.
 */
export async function getBoard() {
  const db = await getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id ASC, position ASC, created_at ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }

  return {
    columns: columns.map((c) => byColumn.get(c.id)),
  };
}

/**
 * Create a card at the end of the given column.
 * Returns the canonical card row.
 */
export async function createCard({ columnId, text }) {
  const db = await getDb();

  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error(`Unknown column: ${columnId}`);
    err.status = 400;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].max_pos) + POSITION_STEP;

  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, text, position]
  );

  return rows[0];
}

/**
 * Move a card into `columnId`, positioned between `afterId` (the card that
 * should end up immediately above the moved card) and `beforeId` (immediately
 * below). Either may be null/undefined (top or bottom of column).
 *
 * The operation is fully transactional: the card's column and position are
 * updated atomically, so no observer ever sees the card in two columns.
 *
 * Returns { card, column } where `column` is the affected column id and, when
 * a renormalization occurred, an array of corrected cards is included.
 */
export async function moveCard({ id, columnId, beforeId, afterId }) {
  const db = await getDb();

  let result;
  await db.transaction(async (tx) => {
    // Validate target column.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error(`Unknown column: ${columnId}`);
      err.status = 400;
      throw err;
    }

    // Validate the card exists.
    const { rows: cardRows } = await tx.query(
      'SELECT id FROM cards WHERE id = $1',
      [id]
    );
    if (cardRows.length === 0) {
      const err = new Error(`Unknown card: ${id}`);
      err.status = 404;
      throw err;
    }

    // Resolve neighbour positions *within the target column*, ignoring the
    // card being moved (in case it is already in this column).
    const afterPos = await neighbourPosition(tx, columnId, afterId, id);
    const beforePos = await neighbourPosition(tx, columnId, beforeId, id);

    const { position, needsRenormalize } = computePosition({
      afterPos,
      beforePos,
      columnId,
    });

    let renormalized = null;
    let finalPosition = position;

    if (needsRenormalize) {
      // Renormalize: lay the column out with even spacing, placing the moved
      // card at the requested slot, then read back the moved card's position.
      renormalized = await renormalizeWithMove(tx, {
        columnId,
        movingId: id,
        afterId,
        beforeId,
      });
      const moved = renormalized.find((c) => c.id === id);
      finalPosition = moved.position;
    } else {
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, finalPosition, id]
      );
    }

    const { rows } = await tx.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards WHERE id = $1`,
      [id]
    );

    result = {
      card: rows[0],
      column: columnId,
      renormalized, // null unless a renormalization happened
    };
  });

  return result;
}

/**
 * Returns the position of `neighbourId` in `columnId`, or null if neighbourId
 * is falsy or the neighbour is not present in that column. `excludeId` is the
 * id of the card being moved and is ignored.
 */
async function neighbourPosition(tx, columnId, neighbourId, excludeId) {
  if (!neighbourId || neighbourId === excludeId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighbourId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Compute the fractional position for a card given the positions of the cards
 * that should sit immediately above (afterPos) and below (beforePos) it.
 * Flags renormalization when the gap is too small to subdivide reliably.
 */
function computePosition({ afterPos, beforePos }) {
  const hasAfter = afterPos !== null && afterPos !== undefined;
  const hasBefore = beforePos !== null && beforePos !== undefined;

  if (!hasAfter && !hasBefore) {
    // Empty column (relative to the moved card): anchor at a base value.
    return { position: POSITION_STEP, needsRenormalize: false };
  }
  if (hasAfter && !hasBefore) {
    // Append after the last card.
    return { position: afterPos + POSITION_STEP, needsRenormalize: false };
  }
  if (!hasAfter && hasBefore) {
    // Prepend before the first card.
    return { position: beforePos - POSITION_STEP, needsRenormalize: false };
  }

  // Insert between two cards.
  const gap = beforePos - afterPos;
  if (gap <= MIN_GAP) {
    // Positions collided or precision exhausted; signal renormalization.
    return { position: null, needsRenormalize: true };
  }
  return { position: afterPos + gap / 2, needsRenormalize: false };
}

/**
 * Renormalize an entire column to evenly-spaced integer positions, inserting
 * the moving card at the slot defined by afterId/beforeId. Returns the full
 * ordered list of cards in the column with their corrected positions.
 */
async function renormalizeWithMove(tx, { columnId, movingId, afterId, beforeId }) {
  // Move the card into the column first so it participates in ordering.
  await tx.query(
    'UPDATE cards SET column_id = $1 WHERE id = $2',
    [columnId, movingId]
  );

  // Current ordering of the column (by position), excluding the moving card.
  const { rows: others } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, created_at ASC`,
    [columnId, movingId]
  );

  const order = others.map((r) => r.id);

  // Determine insertion index based on neighbours.
  let insertIndex;
  if (afterId && order.includes(afterId)) {
    insertIndex = order.indexOf(afterId) + 1;
  } else if (beforeId && order.includes(beforeId)) {
    insertIndex = order.indexOf(beforeId);
  } else if (!afterId && beforeId) {
    insertIndex = 0; // top
  } else {
    insertIndex = order.length; // bottom / default
  }

  order.splice(insertIndex, 0, movingId);

  // Reassign evenly-spaced positions.
  const updated = [];
  for (let i = 0; i < order.length; i++) {
    const pos = (i + 1) * POSITION_STEP;
    const { rows } = await tx.query(
      `UPDATE cards SET position = $1 WHERE id = $2
       RETURNING id, column_id, text, position, created_at`,
      [pos, order[i]]
    );
    updated.push(rows[0]);
  }

  return updated;
}
