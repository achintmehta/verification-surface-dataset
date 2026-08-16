import { randomUUID } from 'node:crypto';

// Gap used when appending a card to the end of a column.
const APPEND_GAP = 1000;
// Minimum allowable gap between two adjacent positions before we consider
// precision exhausted and renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Fetch the full board: ordered columns, each with ordered cards.
 */
export async function getBoard(db) {
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
    if (col) col.cards.push(card);
  }
  return { columns: Array.from(byColumn.values()) };
}

/**
 * Create a card at the end of the given column.
 * Returns the canonical card row.
 */
export async function createCard(db, columnId, text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    const err = new Error('Card text is required');
    err.status = 400;
    throw err;
  }

  return withTransaction(db, async () => {
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
      'SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const position = Number(maxRows[0].max) + APPEND_GAP;
    const id = randomUUID();

    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, trimmed, position]
    );
    return rows[0];
  });
}

/**
 * Move a card into `columnId`, positioned between `afterId` and `beforeId`.
 *
 * - `afterId` is the card that should end up *above* (lower position) the moved
 *   card; `beforeId` is the card *below* (higher position).
 * - Either may be null/undefined to indicate the start or end of the column.
 *
 * The whole operation runs in a single transaction. If a precision/collision
 * problem is detected, the destination column is renormalized.
 *
 * Returns: { card, renormalized: boolean, columns: { [colId]: [cardRows] } }
 * where `columns` contains the canonical ordered cards for every column whose
 * ordering changed (always the destination, plus the source on cross-column
 * moves).
 */
export async function moveCard(db, cardId, { columnId, beforeId, afterId }) {
  return withTransaction(db, async () => {
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }
    const card = cardRows[0];
    const sourceColumnId = card.column_id;

    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    // Resolve neighbor positions *within the target column*, excluding the card
    // being moved (so a no-op move within the same column is well defined).
    const afterPos = await neighborPosition(db, columnId, afterId, cardId);
    const beforePos = await neighborPosition(db, columnId, beforeId, cardId);

    let newPosition;
    if (afterPos == null && beforePos == null) {
      // No usable neighbors: append to the end of the destination column
      // (excluding the card being moved). This avoids colliding with an
      // existing card when the client's neighbor hints don't resolve.
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1 AND id <> $2',
        [columnId, cardId]
      );
      newPosition = Number(maxRows[0].max) + APPEND_GAP;
    } else {
      newPosition = computePosition(db, columnId, afterPos, beforePos);
    }
    let renormalized = false;

    // Decide whether the requested slot is representable. If not, renormalize
    // the destination column first (with the card temporarily removed from
    // consideration), then recompute neighbor positions and the slot.
    if (!isRepresentable(afterPos, beforePos, newPosition)) {
      renormalized = true;
    }

    // Apply the move (column + position) first.
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    if (renormalized) {
      // Renormalize the destination column to evenly spaced integers, keeping
      // the moved card in its intended slot relative to neighbors.
      await renormalizeColumn(db, columnId);
    }

    const changedColumnIds = new Set([columnId]);
    if (sourceColumnId !== columnId) changedColumnIds.add(sourceColumnId);

    const columns = {};
    for (const cid of changedColumnIds) {
      columns[cid] = await columnCards(db, cid);
    }

    // Re-read the canonical card after any renormalization.
    const { rows: finalRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );

    return { card: finalRows[0], renormalized, columns, sourceColumnId };
  });
}

async function neighborPosition(db, columnId, neighborId, excludeId) {
  if (!neighborId) return null;
  const { rows } = await db.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
    [neighborId, columnId, excludeId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

function computePosition(db, columnId, afterPos, beforePos) {
  // afterPos = lower bound (card above), beforePos = upper bound (card below).
  if (afterPos == null && beforePos == null) {
    // Empty column (relative to this card) -> arbitrary base.
    return APPEND_GAP;
  }
  if (afterPos == null) {
    // Insert at the very top.
    return beforePos - APPEND_GAP;
  }
  if (beforePos == null) {
    // Insert at the very bottom.
    return afterPos + APPEND_GAP;
  }
  // Insert between the two.
  return (afterPos + beforePos) / 2;
}

function isRepresentable(afterPos, beforePos, newPosition) {
  if (!Number.isFinite(newPosition)) return false;
  if (afterPos != null && beforePos != null) {
    // The midpoint must be strictly between the neighbors and not collide.
    if (!(newPosition > afterPos && newPosition < beforePos)) return false;
    if (beforePos - afterPos < MIN_GAP) return false;
  }
  return true;
}

/**
 * Rewrite every card's position in a column to evenly spaced integers,
 * preserving current order. Idempotent and collision-free.
 */
async function renormalizeColumn(db, columnId) {
  const { rows } = await db.query(
    `SELECT id FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let pos = APPEND_GAP;
  for (const row of rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += APPEND_GAP;
  }
}

async function columnCards(db, columnId) {
  const { rows } = await db.query(
    `SELECT id, column_id, text, position, created_at FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return rows;
}

// PGlite executes statements serially per connection, so a BEGIN/COMMIT block
// gives us atomic, isolated multi-statement mutations.
async function withTransaction(db, fn) {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}
