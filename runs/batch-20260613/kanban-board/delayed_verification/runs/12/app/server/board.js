import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Gap used when appending or normalizing positions.
const POSITION_GAP = 1000;
// Minimum separation between two adjacent positions before we consider the
// fractional space "exhausted" and renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Return the full board: every column ordered by position, each with its
 * cards ordered by position. This is the authoritative shape clients render.
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards ORDER BY column_id ASC, position ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }
  return columns.map((c) => byColumn.get(c.id));
}

function serializeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at
  };
}

/**
 * Create a card at the end of the given column.
 * Returns the canonical card.
 */
export async function createCard(columnId, text) {
  const db = getDb();

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
  const maxPos = maxRows[0].max == null ? 0 : Number(maxRows[0].max);
  const position = maxPos + POSITION_GAP;

  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, text, position]
  );
  return serializeCard(rows[0]);
}

/**
 * Compute a position strictly between two neighbours.
 * afterPos/beforePos may be null (meaning "no neighbour on that side").
 */
function computeBetween(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // Empty target column.
    return POSITION_GAP;
  }
  if (afterPos == null) {
    // Insert at the very top.
    return beforePos - POSITION_GAP;
  }
  if (beforePos == null) {
    // Insert at the very bottom.
    return afterPos + POSITION_GAP;
  }
  return (afterPos + beforePos) / 2;
}

/**
 * Move a card into `columnId`, positioned between `afterId` and `beforeId`.
 * - afterId: the card that should end up directly ABOVE the moved card.
 * - beforeId: the card that should end up directly BELOW the moved card.
 * Either may be null/undefined for edge insertions.
 *
 * Runs in a single transaction so the card is never observable in two
 * columns. Handles fractional precision exhaustion by renormalizing the
 * target column and retrying. Returns { card, normalizedColumn } where
 * normalizedColumn is the canonical ordered card list when a renormalization
 * happened (null otherwise).
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    // Resolve neighbour positions within the TARGET column. Ignore the card
    // being moved itself (it may currently be in the target column).
    const afterPos = await neighbourPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighbourPosition(tx, columnId, beforeId, cardId);

    let newPosition = computeBetween(afterPos, beforePos);

    // Detect collision / precision exhaustion: the computed slot is not
    // strictly between the neighbours with enough room.
    const tooTight =
      (afterPos != null && newPosition - afterPos < MIN_GAP) ||
      (beforePos != null && beforePos - newPosition < MIN_GAP) ||
      !Number.isFinite(newPosition);

    if (tooTight) {
      // Renormalize the target column to evenly spaced integers, with the
      // moved card inserted at the requested slot, then read back canonical.
      const normalizedColumn = await renormalizeWithMove(
        tx,
        columnId,
        cardId,
        afterId,
        beforeId
      );
      const moved = normalizedColumn.find((c) => c.id === cardId);
      return { card: moved, normalizedColumn };
    }

    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    const { rows: updated } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    return { card: serializeCard(updated[0]), normalizedColumn: null };
  });
}

async function neighbourPosition(tx, columnId, neighbourId, movingCardId) {
  if (!neighbourId) return null;
  if (neighbourId === movingCardId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighbourId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Rebuild the ordering of `columnId` as evenly spaced integer positions,
 * inserting the moved card between afterId and beforeId. Returns the
 * canonical ordered card list for the column.
 */
async function renormalizeWithMove(tx, columnId, cardId, afterId, beforeId) {
  // Current ordered cards in the target column, excluding the moved card.
  const { rows: existing } = await tx.query(
    `SELECT id FROM cards
     WHERE column_id = $1 AND id <> $2
     ORDER BY position ASC, id ASC`,
    [columnId, cardId]
  );
  const order = existing.map((r) => r.id);

  // Determine insertion index from neighbours.
  let insertAt = order.length;
  if (afterId && order.includes(afterId)) {
    insertAt = order.indexOf(afterId) + 1;
  } else if (beforeId && order.includes(beforeId)) {
    insertAt = order.indexOf(beforeId);
  } else if (!afterId && beforeId == null) {
    // both null -> append (already default)
    insertAt = order.length;
  } else if (!afterId) {
    // top insertion
    insertAt = 0;
  }

  order.splice(insertAt, 0, cardId);

  // Assign evenly spaced positions and ensure the card lands in this column.
  for (let i = 0; i < order.length; i++) {
    const pos = (i + 1) * POSITION_GAP;
    if (order[i] === cardId) {
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, pos, order[i]]
      );
    } else {
      await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
        pos,
        order[i]
      ]);
    }
  }

  const { rows } = await tx.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC`,
    [columnId]
  );
  return rows.map(serializeCard);
}
