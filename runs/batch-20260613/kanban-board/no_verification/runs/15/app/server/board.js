import { randomUUID } from 'node:crypto';

// Spacing used when appending cards to the end of a column.
const STEP = 1000;
// Minimum gap between two adjacent positions before we consider the column
// to need renormalization (guards against double-precision exhaustion).
const MIN_GAP = 1e-6;

/**
 * Returns the full board: ordered columns, each with their ordered cards.
 */
export async function getBoard(db) {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC;'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id, position ASC, id ASC;`
  );

  const cardsByColumn = new Map();
  for (const col of columns) cardsByColumn.set(col.id, []);
  for (const card of cards) {
    if (!cardsByColumn.has(card.column_id)) cardsByColumn.set(card.column_id, []);
    cardsByColumn.get(card.column_id).push(serializeCard(card));
  }

  return columns.map((col) => ({
    id: col.id,
    title: col.title,
    position: col.position,
    cards: cardsByColumn.get(col.id) || [],
  }));
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
export async function createCard(db, columnId, text) {
  // Validate column exists.
  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1;',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1;',
    [columnId]
  );
  const position = Number(maxRows[0].max) + STEP;
  const id = randomUUID();

  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4);',
    [id, columnId, text, position]
  );

  const { rows } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
    [id]
  );
  return serializeCard(rows[0]);
}

/**
 * Compute a position strictly between `after` and `before`.
 * `after` is the card immediately above the drop slot (smaller position),
 * `before` is the card immediately below (larger position).
 * Returns { position, needsRenormalize }.
 */
function computeBetween(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // Empty column.
    return { position: STEP, needsRenormalize: false };
  }
  if (afterPos == null) {
    // Insert at the top.
    return { position: beforePos - STEP, needsRenormalize: false };
  }
  if (beforePos == null) {
    // Insert at the bottom.
    return { position: afterPos + STEP, needsRenormalize: false };
  }
  const gap = beforePos - afterPos;
  if (gap <= MIN_GAP) {
    // Positions too close / collision — signal renormalization.
    return { position: (afterPos + beforePos) / 2, needsRenormalize: true };
  }
  return { position: afterPos + gap / 2, needsRenormalize: false };
}

/**
 * Renormalize all card positions in a column to evenly spaced integers,
 * preserving their current order. Returns the ordered list of cards.
 */
async function renormalizeColumn(db, columnId) {
  const { rows } = await db.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC;`,
    [columnId]
  );
  let pos = STEP;
  for (const row of rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2;', [pos, row.id]);
    pos += STEP;
  }
}

/**
 * Move a card into `columnId` between the cards identified by `afterId`
 * (above) and `beforeId` (below). Performed atomically in a transaction.
 *
 * Returns { card, renormalizedColumn } where renormalizedColumn (when set)
 * contains the canonical ordering of the affected column after renormalization.
 */
export async function moveCard(db, cardId, { columnId, beforeId, afterId }) {
  let result;

  await db.transaction(async (tx) => {
    // Ensure card exists.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id FROM cards WHERE id = $1 FOR UPDATE;',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    // Ensure target column exists.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1;',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    // Look up neighbor positions within the *target* column, ignoring the
    // moving card itself (in case it's already in this column).
    let afterPos = null;
    let beforePos = null;

    if (afterId && afterId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2;',
        [afterId, columnId]
      );
      if (rows.length) afterPos = Number(rows[0].position);
    }
    if (beforeId && beforeId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2;',
        [beforeId, columnId]
      );
      if (rows.length) beforePos = Number(rows[0].position);
    }

    // If only one neighbor was resolvable, derive the missing bound from the
    // column extremes so ordering remains sensible even with stale client ids.
    if (afterPos == null && beforePos == null && (afterId || beforeId)) {
      // Both neighbors unknown but client intended a specific slot; fall back
      // to appending at the end of the column.
      const { rows } = await tx.query(
        `SELECT COALESCE(MAX(position), 0) AS max FROM cards
          WHERE column_id = $1 AND id <> $2;`,
        [columnId, cardId]
      );
      afterPos = Number(rows[0].max);
    }

    let { position, needsRenormalize } = computeBetween(afterPos, beforePos);

    // Update the card atomically: column_id and position together.
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3;',
      [columnId, position, cardId]
    );

    let renormalizedColumn = null;
    if (needsRenormalize) {
      await renormalizeColumnTx(tx, columnId);
      renormalizedColumn = await readColumnCardsTx(tx, columnId);
    }

    const { rows: finalRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1;',
      [cardId]
    );

    result = {
      card: serializeCard(finalRows[0]),
      renormalizedColumn,
      columnId,
    };
  });

  return result;
}

async function renormalizeColumnTx(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC;`,
    [columnId]
  );
  let pos = STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2;', [pos, row.id]);
    pos += STEP;
  }
}

async function readColumnCardsTx(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC;`,
    [columnId]
  );
  return rows.map(serializeCard);
}
