import { getDb } from './db.js';

const POSITION_GAP = 1000;
// When two adjacent positions get too close we renormalize the column.
const MIN_GAP = 1e-6;

// Returns the full board: columns ordered by position, each with ordered cards.
export async function getBoard() {
  const db = await getDb();
  const colRes = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const cardRes = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, id ASC'
  );

  const columns = colRes.rows.map((c) => ({
    id: c.id,
    title: c.title,
    position: c.position,
    cards: [],
  }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const card of cardRes.rows) {
    const col = byId.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }
  return { columns };
}

function serializeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: row.position,
    createdAt: row.created_at,
  };
}

// Create a card at the end of a column.
export async function createCard(columnId, text) {
  const db = await getDb();
  const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (colCheck.rows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const maxRes = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const max = maxRes.rows[0].max;
  const position = (max == null ? 0 : Number(max)) + POSITION_GAP;

  const insertRes = await db.query(
    'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING id, column_id, text, position, created_at',
    [columnId, text, position]
  );
  return serializeCard(insertRes.rows[0]);
}

// Compute a new position for a card between afterId and beforeId within columnId.
// afterId = card that should sit ABOVE the moved card (smaller position).
// beforeId = card that should sit BELOW the moved card (larger position).
// Performs the move atomically. Returns { card, column: { id, cards } } where
// column.cards is the canonical ordered list of the target column (post-move),
// plus the source column ordering if a cross-column move occurred.
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const db = await getDb();

  let result;
  await db.transaction(async (tx) => {
    const cardRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (cardRes.rows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }
    const card = cardRes.rows[0];
    const sourceColumnId = card.column_id;

    const colCheck = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    // Determine neighbor positions within the TARGET column, excluding the
    // card being moved (so moving within the same column behaves correctly).
    let afterPos = null;
    let beforePos = null;

    if (afterId != null) {
      const r = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
        [afterId, columnId, cardId]
      );
      if (r.rows.length > 0) afterPos = Number(r.rows[0].position);
    }
    if (beforeId != null) {
      const r = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
        [beforeId, columnId, cardId]
      );
      if (r.rows.length > 0) beforePos = Number(r.rows[0].position);
    }

    // If the provided neighbors are missing/stale, fall back gracefully by
    // recomputing the boundary positions from the actual column contents.
    if (afterPos == null && afterId != null) {
      // afterId not found in target column; treat as top boundary.
      afterId = null;
    }
    if (beforePos == null && beforeId != null) {
      beforeId = null;
    }

    const newPos = await computePosition(afterPos, beforePos, tx, columnId);

    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, cardId]
    );

    // Detect precision exhaustion: if neighbors are too close, renormalize.
    const needsNormalize = await checkNeedsNormalize(tx, columnId);
    if (needsNormalize) {
      await renormalizeColumn(tx, columnId);
    }
    if (sourceColumnId !== columnId) {
      const srcNeeds = await checkNeedsNormalize(tx, sourceColumnId);
      if (srcNeeds) await renormalizeColumn(tx, sourceColumnId);
    }

    const finalCardRes = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    const movedCard = serializeCard(finalCardRes.rows[0]);

    const targetCards = await orderedColumnCards(tx, columnId);
    const affectedColumns = [{ id: columnId, cards: targetCards }];
    if (sourceColumnId !== columnId) {
      const srcCards = await orderedColumnCards(tx, sourceColumnId);
      affectedColumns.push({ id: sourceColumnId, cards: srcCards });
    }

    result = { card: movedCard, columns: affectedColumns };
  });

  return result;
}

async function computePosition(afterPos, beforePos, tx, columnId) {
  if (afterPos != null && beforePos != null) {
    return (afterPos + beforePos) / 2;
  }
  if (afterPos != null && beforePos == null) {
    // Place at bottom: after afterPos, below everything else too.
    const maxRes = await tx.query(
      'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const max = maxRes.rows[0].max == null ? afterPos : Number(maxRes.rows[0].max);
    return Math.max(afterPos, max) + POSITION_GAP;
  }
  if (afterPos == null && beforePos != null) {
    // Place at top: above beforePos.
    const minRes = await tx.query(
      'SELECT MIN(position) AS min FROM cards WHERE column_id = $1',
      [columnId]
    );
    const min = minRes.rows[0].min == null ? beforePos : Number(minRes.rows[0].min);
    return Math.min(beforePos, min) - POSITION_GAP;
  }
  // No neighbors: empty column (or moving to empty target). Put in middle.
  const cntRes = await tx.query(
    'SELECT COUNT(*)::int AS c, MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  if (cntRes.rows[0].c === 0) return POSITION_GAP;
  return Number(cntRes.rows[0].max) + POSITION_GAP;
}

async function orderedColumnCards(tx, columnId) {
  const res = await tx.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  return res.rows.map(serializeCard);
}

// Check if any two adjacent cards in the column are closer than MIN_GAP,
// which signals precision exhaustion / collision.
async function checkNeedsNormalize(tx, columnId) {
  const res = await tx.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  const rows = res.rows;
  for (let i = 1; i < rows.length; i++) {
    const a = Number(rows[i - 1].position);
    const b = Number(rows[i].position);
    if (b - a < MIN_GAP) return true;
  }
  return false;
}

// Reassign evenly-spaced positions to all cards in the column, preserving order.
async function renormalizeColumn(tx, columnId) {
  const res = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  let pos = POSITION_GAP;
  for (const row of res.rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += POSITION_GAP;
  }
}
