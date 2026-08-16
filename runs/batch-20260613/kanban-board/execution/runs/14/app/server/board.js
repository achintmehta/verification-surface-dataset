import { randomUUID } from 'node:crypto';

// Default gap used when appending cards to the end of a column.
const POSITION_GAP = 1024;
// If the gap between two neighbouring positions drops below this, we renormalize.
const MIN_GAP = 1e-6;

/**
 * Fetch the full board: every column (ordered) with its cards (ordered).
 */
export async function getBoard(db) {
  const { rows: columns } = await db.query(
    `SELECT id, title, position FROM columns ORDER BY position ASC, id ASC`
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY position ASC, created_at ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }
  return Array.from(byColumn.values());
}

/**
 * Create a card at the end of a column.
 * Returns the canonical card row.
 */
export async function createCard(db, columnId, text) {
  // Validate the column exists.
  const { rows: colRows } = await db.query(
    `SELECT id FROM columns WHERE id = $1`,
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error('column not found');
    err.status = 400;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    `SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1`,
    [columnId]
  );
  const position = Number(maxRows[0].maxpos) + POSITION_GAP;
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
 * Move a card into `columnId`, positioned between the card identified by
 * `afterId` (the neighbour above / before it) and `beforeId` (the neighbour
 * below / after it). Either may be null (top or bottom of the column).
 *
 * The whole operation runs in a single transaction. If fractional precision is
 * exhausted (neighbouring positions too close), the target column is
 * renormalized and the affected cards are returned so they can be broadcast.
 *
 * Returns: { card, normalizedColumns: [{ columnId, cards: [...] }] }
 *   - card: the canonical moved card
 *   - normalizedColumns: any columns whose ordering was renormalized
 */
export async function moveCard(db, cardId, { columnId, beforeId, afterId }) {
  let result;
  await db.transaction(async (tx) => {
    // Lock-free but transactional: PGlite is single-connection so the tx is serial.
    const { rows: cardRows } = await tx.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('card not found');
      err.status = 404;
      throw err;
    }

    const { rows: colRows } = await tx.query(
      `SELECT id FROM columns WHERE id = $1`,
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('column not found');
      err.status = 400;
      throw err;
    }

    // Resolve the neighbouring positions inside the *target* column, ignoring
    // the card being moved (it may currently live in this column).
    const afterPos = await neighbourPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighbourPosition(tx, columnId, beforeId, cardId);

    const newPosition = computePosition(afterPos, beforePos);

    const normalizedColumns = [];

    if (newPosition === null) {
      // Precision exhausted / collision between neighbours: renormalize the
      // target column, then place the card relative to the *resolved* anchors.
      await tx.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
        [columnId, 0, cardId] // temporarily park; real position assigned below
      );
      const cards = await renormalizeAndPlace(tx, columnId, cardId, afterId, beforeId);
      normalizedColumns.push({ columnId, cards });
    } else {
      await tx.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
        [columnId, newPosition, cardId]
      );
    }

    const { rows: updated } = await tx.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [cardId]
    );
    result = { card: updated[0], normalizedColumns };
  });
  return result;
}

async function neighbourPosition(tx, columnId, neighbourId, movingCardId) {
  if (!neighbourId) return null;
  const { rows } = await tx.query(
    `SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3`,
    [neighbourId, columnId, movingCardId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Compute a position strictly between afterPos and beforePos.
 *   - afterPos null  => insert at top (below nothing): below beforePos
 *   - beforePos null => insert at bottom: above afterPos
 *   - both null      => empty column
 * Returns null if there is not enough numeric room (caller must renormalize).
 */
function computePosition(afterPos, beforePos) {
  if (afterPos === null && beforePos === null) {
    return POSITION_GAP;
  }
  if (afterPos === null) {
    // Insert at the very top, before `beforePos`.
    return beforePos / 2;
  }
  if (beforePos === null) {
    // Insert at the very bottom, after `afterPos`.
    return afterPos + POSITION_GAP;
  }
  // Between two cards.
  if (beforePos - afterPos <= MIN_GAP) {
    return null; // exhausted
  }
  return (afterPos + beforePos) / 2;
}

/**
 * Renormalize a column to evenly spaced integer positions, ensuring the moved
 * card lands between `afterId` and `beforeId`. Returns the column's cards in
 * canonical order after renormalization.
 */
async function renormalizeAndPlace(tx, columnId, movingCardId, afterId, beforeId) {
  // Get all cards in the column in current order. The moving card is already
  // assigned column_id = columnId.
  const { rows } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );

  // Build desired ordering: take existing order minus the moving card, then
  // splice the moving card into the requested slot.
  let order = rows.map((r) => r.id).filter((id) => id !== movingCardId);

  let insertIdx;
  if (afterId && order.includes(afterId)) {
    insertIdx = order.indexOf(afterId) + 1;
  } else if (beforeId && order.includes(beforeId)) {
    insertIdx = order.indexOf(beforeId);
  } else if (!afterId) {
    insertIdx = 0; // top
  } else {
    insertIdx = order.length; // bottom
  }
  order.splice(insertIdx, 0, movingCardId);

  // Assign evenly spaced positions.
  for (let i = 0; i < order.length; i++) {
    await tx.query(`UPDATE cards SET position = $1 WHERE id = $2`, [
      (i + 1) * POSITION_GAP,
      order[i]
    ]);
  }

  const { rows: finalRows } = await tx.query(
    `SELECT id, column_id, text, position, created_at FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return finalRows;
}
