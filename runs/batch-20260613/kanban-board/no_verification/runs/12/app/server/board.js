import { randomUUID } from 'node:crypto';
import { computePosition, STEP } from './ordering.js';

/**
 * Fetch the full board: ordered columns, each with its ordered cards.
 */
export async function getBoard(db) {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of columns) byColumn.set(col.id, []);
  for (const card of cards) {
    if (byColumn.has(card.column_id)) byColumn.get(card.column_id).push(card);
  }

  return columns.map((col) => ({
    id: col.id,
    title: col.title,
    position: col.position,
    cards: byColumn.get(col.id) || []
  }));
}

/**
 * Create a card at the end of a column.
 */
export async function createCard(db, columnId, text) {
  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = maxRows[0].max;
  const position = maxPos === null ? STEP : maxPos + STEP;

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
 * Renormalize all cards in a column to evenly spaced positions, preserving
 * the order implied by the supplied ordered id list. Returns the updated
 * cards in canonical order.
 */
async function renormalizeColumn(db, columnId, orderedIds) {
  const updated = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const pos = (i + 1) * STEP;
    const { rows } = await db.query(
      `UPDATE cards SET position = $1 WHERE id = $2
       RETURNING id, column_id, text, position, created_at`,
      [pos, orderedIds[i]]
    );
    if (rows.length) updated.push(rows[0]);
  }
  return updated;
}

/**
 * Move a card into a column, positioned between afterId and beforeId.
 * Performed atomically in a transaction. Returns the canonical moved card
 * and, when renormalization happened, the full corrected column order.
 *
 * @returns {{ card: object, column: { id: string, cards: object[] }, renormalized: boolean }}
 */
export async function moveCard(db, cardId, { columnId, beforeId, afterId }) {
  let result;

  await db.transaction(async (tx) => {
    // Ensure the card exists.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Ensure the target column exists.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    // Look up neighbour positions (only valid if they're in the target column
    // and are not the card being moved).
    let afterPos = null;
    let beforePos = null;

    if (afterId && afterId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (rows.length) afterPos = rows[0].position;
    }
    if (beforeId && beforeId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (rows.length) beforePos = rows[0].position;
    }

    const { position, needsRenormalize } = computePosition(afterPos, beforePos);

    // Atomically update column + position (removes from source, adds to target).
    const { rows: movedRows } = await tx.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, position, cardId]
    );
    const movedCard = movedRows[0];

    if (needsRenormalize) {
      // Build the desired order for the target column, then evenly space it.
      const { rows: colCards } = await tx.query(
        'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
        [columnId]
      );
      const orderedIds = colCards.map((c) => c.id);
      const cards = await renormalizeColumn(tx, columnId, orderedIds);
      const refreshed = cards.find((c) => c.id === cardId) || movedCard;
      result = {
        card: refreshed,
        column: { id: columnId, cards },
        renormalized: true
      };
    } else {
      result = {
        card: movedCard,
        column: null,
        renormalized: false
      };
    }
  });

  return result;
}
