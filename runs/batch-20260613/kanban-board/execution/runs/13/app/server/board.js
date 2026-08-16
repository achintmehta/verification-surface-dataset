import { getDb, newId } from './db.js';

// Minimum gap allowed between two fractional positions before we consider
// numeric precision "exhausted" and renormalize the column.
const MIN_GAP = 1e-6;
// Spacing used when (re)normalizing a column's positions.
const STEP = 1000;

/**
 * Return the full board: columns ordered by position, each with its cards
 * ordered by position (stable: ties broken by created_at then id).
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
   ORDER BY column_id ASC, position ASC, created_at ASC, id ASC`
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
    cards: (byColumn.get(col.id) || []).map(serializeCard),
  }));
}

function serializeCard(c) {
  return {
    id: c.id,
    columnId: c.column_id,
    text: c.text,
    position: c.position,
    createdAt: c.created_at,
  };
}

/**
 * Create a card at the end of a column.
 * Returns the canonical serialized card.
 */
export async function createCard(columnId, text) {
  const db = getDb();

  const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (colRows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].maxpos) + STEP;
  const id = newId('card');

  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, text, position]
  );
  return serializeCard(rows[0]);
}

/**
 * Move a card into `columnId` between `afterId` (the card it should follow)
 * and `beforeId` (the card it should precede). The server is authoritative:
 * it computes the canonical position, handling collisions/precision
 * exhaustion by renormalizing the column.
 *
 * Returns { card, normalizedColumn } where:
 *   - card is the canonical serialized moved card
 *   - normalizedColumn (optional) is { columnId, cards: [...] } when the
 *     target column had to be renormalized (so clients can snap to order)
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = getDb();
  let result;

  await db.transaction(async (tx) => {
    // Lock-free but atomic within the transaction.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    const { rows: colRows } = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    // Fetch neighbor positions within the TARGET column, excluding the moving
    // card itself (it may already be in this column when reordering).
    const after = afterId
      ? await fetchNeighbor(tx, columnId, afterId, cardId)
      : null;
    const before = beforeId
      ? await fetchNeighbor(tx, columnId, beforeId, cardId)
      : null;

    let newPos = computePosition(after, before);

    // Atomically remove-from-source / add-to-target: a single UPDATE changes
    // both column_id and position so the card is never in two columns.
    await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      newPos,
      cardId,
    ]);

    // Detect collision / precision exhaustion: if the new position is not
    // strictly between its intended neighbors, renormalize the column.
    const needsNormalize = positionInvalid(after, before, newPos);

    if (needsNormalize) {
      await renormalizeColumn(tx, columnId);
      // Re-read the moved card's canonical position after normalization.
    }

    const { rows: finalRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    const card = serializeCard(finalRows[0]);

    let normalizedColumn = null;
    if (needsNormalize) {
      const { rows: colCards } = await tx.query(
        `SELECT id, column_id, text, position, created_at
           FROM cards WHERE column_id = $1
       ORDER BY position ASC, created_at ASC, id ASC`,
        [columnId]
      );
      normalizedColumn = { columnId, cards: colCards.map(serializeCard) };
    }

    result = { card, normalizedColumn };
  });

  return result;
}

async function fetchNeighbor(tx, columnId, neighborId, movingId) {
  if (neighborId === movingId) return null;
  const { rows } = await tx.query(
    'SELECT id, position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, position: Number(rows[0].position) };
}

function computePosition(after, before) {
  const a = after ? after.position : null;
  const b = before ? before.position : null;

  if (a == null && b == null) {
    // Empty (relative to neighbors) — place at a default anchor.
    return STEP;
  }
  if (a == null) {
    // Insert before the first card.
    return b - STEP;
  }
  if (b == null) {
    // Insert after the last card.
    return a + STEP;
  }
  // Between two cards.
  return (a + b) / 2;
}

function positionInvalid(after, before, pos) {
  const a = after ? after.position : null;
  const b = before ? before.position : null;

  if (a != null && b != null) {
    // Must be strictly between, with enough gap on each side.
    if (!(pos - a > MIN_GAP && b - pos > MIN_GAP)) return true;
    if (!(b - a > MIN_GAP * 2)) return true;
  } else if (a != null) {
    if (!(pos - a > MIN_GAP)) return true;
  } else if (b != null) {
    if (!(b - pos > MIN_GAP)) return true;
  }
  if (!Number.isFinite(pos)) return true;
  return false;
}

/**
 * Renormalize a column so card positions become STEP, 2*STEP, 3*STEP ...
 * preserving the current sort order. Called inside a transaction.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let pos = STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += STEP;
  }
}
