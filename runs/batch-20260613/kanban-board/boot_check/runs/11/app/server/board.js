import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Spacing used when appending cards to the end of a column and when
// renormalizing positions.
const POSITION_STEP = 1000;

// If the gap between two neighbouring positions is below this threshold we
// consider fractional precision effectively exhausted and renormalize.
const MIN_GAP = 1e-6;

/**
 * Return the full board: every column (ordered by position) with its cards
 * (ordered by position, then created_at as a stable tie-breaker).
 */
export async function getBoard() {
  const db = getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY position ASC, created_at ASC, id ASC`
  );

  const byColumn = new Map(columns.map((c) => [c.id, { ...c, cards: [] }]));
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }

  return {
    columns: columns.map((c) => byColumn.get(c.id)),
  };
}

function serializeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

/**
 * Create a card at the end of the given column.
 */
export async function createCard({ columnId, text }) {
  const db = getDb();

  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error(`Unknown column: ${columnId}`);
    err.status = 400;
    throw err;
  }

  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    const err = new Error('Card text is required');
    err.status = 400;
    throw err;
  }

  const id = randomUUID();
  let card;

  await db.transaction(async (tx) => {
    const { rows: maxRows } = await tx.query(
      'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const max = maxRows[0].max;
    const position = (max === null ? 0 : Number(max)) + POSITION_STEP;

    const { rows } = await tx.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, trimmed, position]
    );
    card = serializeCard(rows[0]);
  });

  return card;
}

/**
 * Compute the canonical position for a card moving into `columnId`, between
 * `afterId` (the card that should end up immediately above) and `beforeId`
 * (the card that should end up immediately below).
 *
 * The move (column reassignment + position update) is performed atomically in
 * a single transaction so no client can ever observe the card in two columns.
 *
 * On fractional precision exhaustion (or a degenerate neighbour ordering) the
 * destination column is renormalized so all positions stay total and stable.
 *
 * Returns { card, renormalizedColumnId } where renormalizedColumnId is set
 * when the destination column's positions were rewritten.
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  const db = getDb();
  let result;

  await db.transaction(async (tx) => {
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error(`Unknown card: ${cardId}`);
      err.status = 404;
      throw err;
    }

    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error(`Unknown column: ${columnId}`);
      err.status = 400;
      throw err;
    }

    // Fetch the destination column's cards (excluding the moving card) in
    // canonical order. We resolve neighbour positions from this authoritative
    // snapshot rather than trusting client-sent positions.
    const { rows: siblings } = await tx.query(
      `SELECT id, position
         FROM cards
        WHERE column_id = $1 AND id <> $2
        ORDER BY position ASC, created_at ASC, id ASC`,
      [columnId, cardId]
    );

    const afterPos = resolvePosition(siblings, afterId);
    const beforePos = resolvePosition(siblings, beforeId);

    let newPosition;
    let needsRenormalize = false;

    if (afterPos === null && beforePos === null) {
      // Empty target (other than the moving card): place in the middle.
      newPosition = POSITION_STEP;
    } else if (afterPos === null) {
      // Insert at the top, above the first sibling.
      newPosition = beforePos - POSITION_STEP;
    } else if (beforePos === null) {
      // Insert at the bottom, below the last sibling.
      newPosition = afterPos + POSITION_STEP;
    } else {
      // Insert strictly between two siblings.
      if (beforePos - afterPos <= MIN_GAP) {
        needsRenormalize = true;
      } else {
        newPosition = afterPos + (beforePos - afterPos) / 2;
      }
    }

    if (!needsRenormalize) {
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Guard against floating point collisions: if the computed position is
      // not strictly between its intended neighbours, renormalize.
      if (
        (afterPos !== null && newPosition <= afterPos) ||
        (beforePos !== null && newPosition >= beforePos)
      ) {
        needsRenormalize = true;
      }
    }

    if (needsRenormalize) {
      await renormalizeWithInsert(tx, columnId, cardId, afterId, beforeId);
      result = { renormalizedColumnId: columnId };
    } else {
      result = { renormalizedColumnId: null };
    }

    const { rows: finalRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    result.card = serializeCard(finalRows[0]);
  });

  return result;
}

function resolvePosition(siblings, id) {
  if (!id) return null;
  const found = siblings.find((s) => s.id === id);
  return found ? Number(found.position) : null;
}

/**
 * Renormalize a column's positions to evenly spaced integers, placing the
 * moving card between its requested neighbours. This restores a total, stable
 * ordering after a collision or precision exhaustion.
 */
async function renormalizeWithInsert(tx, columnId, cardId, afterId, beforeId) {
  // Make sure the moving card belongs to the destination column first.
  await tx.query('UPDATE cards SET column_id = $1 WHERE id = $2', [
    columnId,
    cardId,
  ]);

  const { rows: ordered } = await tx.query(
    `SELECT id
       FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId, cardId]
  );

  const ids = ordered.map((r) => r.id);

  // Determine the insertion index based on the requested neighbours.
  let insertIndex;
  if (afterId && ids.includes(afterId)) {
    insertIndex = ids.indexOf(afterId) + 1;
  } else if (beforeId && ids.includes(beforeId)) {
    insertIndex = ids.indexOf(beforeId);
  } else if (!afterId) {
    insertIndex = 0; // top
  } else {
    insertIndex = ids.length; // bottom
  }

  ids.splice(insertIndex, 0, cardId);

  for (let i = 0; i < ids.length; i++) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (i + 1) * POSITION_STEP,
      ids[i],
    ]);
  }
}

/**
 * Return the canonical ordered list of cards for a column (used to broadcast
 * the corrected order after a renormalization).
 */
export async function getColumnCards(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return rows.map(serializeCard);
}
