import { getDb, genId } from './db.js';

// Spacing used when appending cards or renormalizing a column.
const POSITION_STEP = 1000;
// Minimum gap between two fractional positions before we consider precision
// "exhausted" and trigger a renormalization of the column.
const MIN_GAP = 1e-6;

/**
 * Return the full board: all columns ordered by position, each with its cards
 * ordered by position.
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position,
            extract(epoch from created_at) AS created_at
     FROM cards
     ORDER BY position ASC, id ASC`
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
    cards: byColumn.get(col.id) || [],
  }));
}

/** Create a card at the end of a column. Returns the canonical card. */
export async function createCard(columnId, text) {
  const db = getDb();

  // Validate column exists.
  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error('Column not found');
    err.status = 400;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].max) + POSITION_STEP;

  const id = genId();
  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position,
               extract(epoch from created_at) AS created_at`,
    [id, columnId, text, position]
  );

  return rows[0];
}

/**
 * Move a card into `columnId`, positioned between the card identified by
 * `afterId` (the card that should end up directly above the moved card) and
 * `beforeId` (the card directly below it). Either may be null for the ends of
 * the column.
 *
 * The server is authoritative: it computes the canonical position from the
 * *current persisted* positions of afterId/beforeId, performs the column +
 * position update atomically in a transaction, and may renormalize the column
 * if fractional precision is exhausted.
 *
 * Returns: { card, renormalized: [{id, column_id, position}, ...] }
 * where `renormalized` lists every card whose position changed besides the
 * moved card (empty unless a renormalization happened).
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    // Lock-free but transactional: PGLite is single-connection so the
    // transaction is effectively serialized.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, position FROM cards WHERE id = $1',
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
      const err = new Error('Target column not found');
      err.status = 400;
      throw err;
    }

    // Resolve neighbor positions from authoritative state. Ignore neighbors
    // that don't exist or aren't actually in the target column.
    const afterPos = await neighborPosition(tx, afterId, columnId, cardId);
    const beforePos = await neighborPosition(tx, beforeId, columnId, cardId);

    let newPosition = computePosition(afterPos, beforePos);

    // Apply the move atomically (remove from source + add to target is a single
    // UPDATE of column_id + position, so the card is never in two columns).
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    // Detect collision / precision exhaustion in the target column and
    // renormalize if necessary.
    let renormalized = [];
    if (needsRenormalize(afterPos, beforePos, newPosition)) {
      renormalized = await renormalizeColumn(tx, columnId);
      // Refresh moved card's position after renormalization.
      const { rows: refreshed } = await tx.query(
        'SELECT position FROM cards WHERE id = $1',
        [cardId]
      );
      newPosition = Number(refreshed[0].position);
    }

    const { rows: finalRows } = await tx.query(
      `SELECT id, column_id, text, position,
              extract(epoch from created_at) AS created_at
       FROM cards WHERE id = $1`,
      [cardId]
    );

    return { card: finalRows[0], renormalized };
  });
}

async function neighborPosition(tx, neighborId, columnId, movingId) {
  if (!neighborId || neighborId === movingId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Compute a fractional position between `after` and `before`.
 * - both null: first card => POSITION_STEP
 * - only after: append => after + STEP
 * - only before: prepend => before - STEP (or before/2 to stay positive-ish)
 * - both: midpoint
 */
export function computePosition(after, before) {
  if (after == null && before == null) return POSITION_STEP;
  if (after == null) return before - POSITION_STEP;
  if (before == null) return after + POSITION_STEP;
  return (after + before) / 2;
}

function needsRenormalize(after, before, newPosition) {
  // If neighbors are too close together, or the new position is not strictly
  // between them (collision), renormalize.
  if (after != null && before != null) {
    if (before - after < MIN_GAP) return true;
    if (newPosition <= after || newPosition >= before) return true;
  }
  return false;
}

/**
 * Reassign evenly spaced positions to every card in a column, preserving the
 * current order. Returns the list of cards whose positions changed.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  const changed = [];
  let pos = POSITION_STEP;
  for (const row of rows) {
    if (Number(row.position) !== pos) {
      await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
      changed.push({ id: row.id, column_id: columnId, position: pos });
    } else {
      changed.push({ id: row.id, column_id: columnId, position: pos });
    }
    pos += POSITION_STEP;
  }
  return changed;
}
