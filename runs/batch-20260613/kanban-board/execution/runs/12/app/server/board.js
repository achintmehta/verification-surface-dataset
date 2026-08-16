import { db } from './db.js';

// Spacing used when appending cards to the end of a column and when
// renormalizing a column's positions.
const POSITION_STEP = 1000;

// If two adjacent positions are closer than this, fractional insertion has
// effectively exhausted double precision and we renormalize.
const MIN_GAP = 1e-6;

function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Return the full board: columns ordered by position, each with its cards
 * ordered by position.
 */
export async function getBoard() {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id ASC, position ASC, created_at ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }
  return { columns: columns.map((c) => byColumn.get(c.id)) };
}

async function getColumn(columnId) {
  const { rows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  return rows[0] || null;
}

/**
 * Create a card at the end of a column.
 */
export async function createCard({ columnId, text }) {
  const column = await getColumn(columnId);
  if (!column) {
    const err = new Error(`Unknown column: ${columnId}`);
    err.status = 400;
    throw err;
  }
  const trimmed = (text ?? '').toString().trim();
  if (!trimmed) {
    const err = new Error('Card text is required');
    err.status = 400;
    throw err;
  }

  const { rows } = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = rows[0].max;
  const position = (maxPos == null ? 0 : Number(maxPos)) + POSITION_STEP;

  const id = randomId('card');
  const { rows: inserted } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, trimmed, position]
  );
  return inserted[0];
}

/**
 * Move a card into columnId, positioned between afterId and beforeId.
 * Atomic: column_id and position update happen in one transaction, so a card
 * is never observable in two columns. Returns:
 *   { card, renormalized?: Card[] }
 * where `card` is the canonical moved card and `renormalized` (if present) is
 * the full corrected order of the destination column.
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  return db.transaction(async (tx) => {
    const { rows: existing } = await tx.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cardId]
    );
    if (!existing[0]) {
      const err = new Error(`Unknown card: ${cardId}`);
      err.status = 404;
      throw err;
    }

    const { rows: col } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (!col[0]) {
      const err = new Error(`Unknown column: ${columnId}`);
      err.status = 400;
      throw err;
    }

    // First, atomically attach the card to the target column. From this point
    // the card belongs to exactly one column for any committed read.
    await tx.query('UPDATE cards SET column_id = $1 WHERE id = $2', [
      columnId,
      cardId,
    ]);

    // Compute neighbor-based position within the (now updated) target column.
    const { target, needsRenormalize } = await computePositionTx(
      tx,
      columnId,
      cardId,
      afterId,
      beforeId
    );

    if (needsRenormalize) {
      const affected = await renormalizeColumnTx(
        tx,
        columnId,
        cardId,
        afterId,
        beforeId
      );
      const card = affected.find((c) => c.id === cardId);
      return { card, renormalized: affected, columnId };
    }

    const { rows: updated } = await tx.query(
      `UPDATE cards SET position = $1 WHERE id = $2
       RETURNING id, column_id, text, position, created_at`,
      [target, cardId]
    );
    return { card: updated[0], columnId };
  });
}

// Transaction-scoped variants of the helpers above. PGLite's transaction
// object exposes the same query() API.
async function computePositionTx(tx, columnId, movingId, afterId, beforeId) {
  let lower = null;
  let upper = null;

  if (afterId && afterId !== movingId) {
    const { rows } = await tx.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [afterId, columnId]
    );
    if (rows[0]) lower = Number(rows[0].position);
  }
  if (beforeId && beforeId !== movingId) {
    const { rows } = await tx.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [beforeId, columnId]
    );
    if (rows[0]) upper = Number(rows[0].position);
  }

  if (upper == null && beforeId == null) {
    const { rows } = await tx.query(
      'SELECT MAX(position) AS max FROM cards WHERE column_id = $1 AND id <> $2',
      [columnId, movingId]
    );
    const max = rows[0].max;
    if (max != null) {
      lower = lower != null ? Math.max(lower, Number(max)) : Number(max);
    }
  }
  if (lower == null && afterId == null && (upper != null || beforeId != null)) {
    const { rows } = await tx.query(
      'SELECT MIN(position) AS min FROM cards WHERE column_id = $1 AND id <> $2',
      [columnId, movingId]
    );
    const min = rows[0].min;
    if (min != null) upper = upper != null ? Math.min(upper, Number(min)) : Number(min);
  }

  let target;
  if (lower == null && upper == null) {
    target = POSITION_STEP;
  } else if (lower == null) {
    target = upper - POSITION_STEP;
  } else if (upper == null) {
    target = lower + POSITION_STEP;
  } else {
    target = (lower + upper) / 2;
  }

  const needsRenormalize =
    (lower != null && upper != null && upper - lower < MIN_GAP) ||
    (lower != null && Math.abs(target - lower) < MIN_GAP) ||
    (upper != null && Math.abs(upper - target) < MIN_GAP) ||
    !Number.isFinite(target);

  return { target, needsRenormalize };
}

async function renormalizeColumnTx(tx, columnId, movingId, afterId, beforeId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1 AND id <> $2
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId, movingId]
  );
  const order = rows.map((r) => r.id);

  let index;
  if (afterId && order.includes(afterId)) {
    index = order.indexOf(afterId) + 1;
  } else if (beforeId && order.includes(beforeId)) {
    index = order.indexOf(beforeId);
  } else if (afterId == null && beforeId != null) {
    index = 0;
  } else {
    index = order.length;
  }
  order.splice(index, 0, movingId);

  const affected = [];
  for (let i = 0; i < order.length; i++) {
    const pos = (i + 1) * POSITION_STEP;
    const { rows: upd } = await tx.query(
      `UPDATE cards SET position = $1 WHERE id = $2
       RETURNING id, column_id, text, position, created_at`,
      [pos, order[i]]
    );
    if (upd[0]) affected.push(upd[0]);
  }
  return affected;
}
