import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { computePosition, POSITION_STEP } from './ordering.js';

/**
 * Return the full board: ordered columns, each with its ordered cards.
 */
export async function getBoard() {
  const db = await getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, created_at ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }

  return {
    columns: columns.map((c) => byColumn.get(c.id))
  };
}

export function serializeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at
  };
}

/**
 * Create a card at the end of a column.
 */
export async function createCard(columnId, text) {
  const db = await getDb();

  // Validate column exists.
  const { rows: cols } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (cols.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = maxRows[0].maxpos;
  const position = maxPos === null ? POSITION_STEP : Number(maxPos) + POSITION_STEP;

  const id = randomUUID();
  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, text, position]
  );

  const { rows } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [id]
  );
  return serializeCard(rows[0]);
}

/**
 * Move a card into `columnId`, positioned between `afterId` and `beforeId`.
 *
 * `afterId`  = the card that should end up immediately *above* the moved card.
 * `beforeId` = the card that should end up immediately *below* the moved card.
 *
 * The whole operation runs in a single transaction so no client can ever
 * observe the card in two columns. Returns the canonical moved card and, when
 * a renormalization occurred, the corrected ordering of the target column.
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = await getDb();

  let result;
  await db.transaction(async (tx) => {
    // Lock & validate the card.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position FROM cards WHERE id = $1 FOR UPDATE',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Validate target column.
    const { rows: cols } = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (cols.length === 0) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    result = await placeCard(tx, cardId, columnId, beforeId, afterId);
  });

  return result;
}

/**
 * Core placement logic, executed inside a transaction (tx).
 * Resolves neighbor positions, computes a fractional position, and
 * renormalizes the column if collision/exhaustion is detected.
 */
async function placeCard(tx, cardId, columnId, beforeId, afterId) {
  // Fetch neighbor positions within the target column, excluding the moving card.
  const afterPos = await neighborPosition(tx, afterId, columnId, cardId);
  const beforePos = await neighborPosition(tx, beforeId, columnId, cardId);

  let renormalized = false;
  let { position, needsRenormalize } = computePosition(afterPos, beforePos);

  if (needsRenormalize) {
    // First move the card into the target column so it participates in the
    // renormalized ordering. We place it temporarily, then renormalize.
    // To preserve the intended slot we renormalize *with* the target index.
    await tx.query('UPDATE cards SET column_id = $1 WHERE id = $2', [columnId, cardId]);
    await renormalizeColumnWithPlacement(tx, columnId, cardId, afterId, beforeId);
    renormalized = true;
  } else {
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, position, cardId]
    );
  }

  // Read back the canonical card.
  const { rows } = await tx.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [cardId]
  );
  const card = serializeCard(rows[0]);

  // Read back the canonical ordering of the target column (used on renormalize
  // so clients can snap to the corrected order).
  const { rows: colCards } = await tx.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );

  return {
    card,
    columnId,
    renormalized,
    column: {
      id: columnId,
      cards: colCards.map(serializeCard)
    }
  };
}

async function neighborPosition(tx, neighborId, columnId, movingCardId) {
  if (!neighborId || neighborId === movingCardId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Renormalize a column's positions to evenly spaced integers, placing
 * `cardId` into the slot defined by its `afterId`/`beforeId` neighbors.
 */
async function renormalizeColumnWithPlacement(tx, columnId, cardId, afterId, beforeId) {
  const { rows } = await tx.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );

  // Build the ordered id list excluding the moving card, then splice it in.
  const ids = rows.map((r) => r.id).filter((id) => id !== cardId);

  let insertIndex;
  if (afterId && ids.includes(afterId)) {
    insertIndex = ids.indexOf(afterId) + 1;
  } else if (beforeId && ids.includes(beforeId)) {
    insertIndex = ids.indexOf(beforeId);
  } else if (!afterId && beforeId === undefined) {
    insertIndex = ids.length;
  } else if (!afterId) {
    // Front of column.
    insertIndex = 0;
  } else {
    insertIndex = ids.length;
  }

  ids.splice(insertIndex, 0, cardId);

  // Assign evenly spaced positions.
  for (let i = 0; i < ids.length; i++) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (i + 1) * POSITION_STEP,
      ids[i]
    ]);
  }
}
