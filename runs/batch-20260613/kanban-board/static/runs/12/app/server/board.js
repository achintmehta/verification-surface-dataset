import { randomUUID } from 'node:crypto';

// Spacing used when appending cards / renormalizing positions.
const POSITION_STEP = 1000;
// If two adjacent positions are closer than this, we treat the gap as
// exhausted and renormalize the column to restore usable spacing.
const MIN_GAP = 1e-6;

/**
 * Fetch the entire board: ordered columns, each with its ordered cards.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
export async function getBoard(db) {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of columns) byColumn.set(col.id, []);
  for (const card of cards) {
    const list = byColumn.get(card.column_id);
    if (list) list.push(serializeCard(card));
  }

  return columns.map((col) => ({
    id: col.id,
    title: col.title,
    position: col.position,
    cards: byColumn.get(col.id) || [],
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
 * @returns {object} the canonical serialized card.
 */
export async function createCard(db, columnId, text) {
  const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (colCheck.rows.length === 0) {
    const err = new Error('Column not found');
    err.statusCode = 404;
    throw err;
  }

  const { rows } = await db.query(
    'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxpos = rows[0].maxpos;
  const position = maxpos == null ? POSITION_STEP : Number(maxpos) + POSITION_STEP;

  const id = randomUUID();
  const insert = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, text, position]
  );
  return serializeCard(insert.rows[0]);
}

/**
 * Move a card into a target column between afterId and beforeId.
 *
 * Client intent: place the card so that it sits *after* `afterId` and
 * *before* `beforeId` in the target column's ordering. Either neighbor may be
 * null (top or bottom of the column).
 *
 * The server computes the canonical position, performs the update atomically,
 * and detects/repairs position collision or precision exhaustion by
 * renormalizing the whole column.
 *
 * @returns {{ card: object, columnId: string, renormalized: boolean, column: object[]|null }}
 */
export async function moveCard(db, cardId, { columnId, beforeId, afterId }) {
  let result;
  await db.transaction(async (tx) => {
    const cardRes = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRes.rows.length === 0) {
      const err = new Error('Card not found');
      err.statusCode = 404;
      throw err;
    }

    const colRes = await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRes.rows.length === 0) {
      const err = new Error('Target column not found');
      err.statusCode = 404;
      throw err;
    }

    // Resolve neighbor positions within the *target* column. We ignore the
    // moving card itself so that no-op / same-column moves behave correctly.
    const afterPos = await neighborPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighborPosition(tx, columnId, beforeId, cardId);

    let lower = afterPos; // the card directly above the insertion slot
    let upper = beforePos; // the card directly below the insertion slot

    let newPos = computePosition(lower, upper);

    // Apply the move atomically: changing column_id and position together.
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, cardId]
    );

    // Detect collision/exhaustion: if the gap was too small, or the new
    // position now ties another card, renormalize the entire target column.
    const needsRenorm =
      (lower != null && upper != null && upper - lower < MIN_GAP) ||
      (await hasCollision(tx, columnId));

    let renormalized = false;
    if (needsRenorm) {
      await renormalizeColumn(tx, columnId);
      renormalized = true;
    }

    const finalCardRes = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    const card = serializeCard(finalCardRes.rows[0]);

    let column = null;
    if (renormalized) {
      const colCards = await tx.query(
        `SELECT id, column_id, text, position, created_at FROM cards
         WHERE column_id = $1 ORDER BY position ASC, id ASC`,
        [columnId]
      );
      column = colCards.rows.map(serializeCard);
    }

    result = { card, columnId, renormalized, column };
  });
  return result;
}

/**
 * Resolve the position of a neighbor card in a given column, excluding the
 * moving card. Returns null when the neighbor reference is null or not present
 * in the target column.
 */
async function neighborPosition(tx, columnId, neighborId, movingId) {
  if (!neighborId || neighborId === movingId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Compute a fractional position given the lower (above) and upper (below)
 * neighbor positions. Null means open-ended.
 */
function computePosition(lower, upper) {
  if (lower == null && upper == null) return POSITION_STEP;
  if (lower == null) return upper - POSITION_STEP;
  if (upper == null) return lower + POSITION_STEP;
  return (lower + upper) / 2;
}

/** True if any two cards in the column share an identical position. */
async function hasCollision(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT position, COUNT(*)::int AS n FROM cards
     WHERE column_id = $1 GROUP BY position HAVING COUNT(*) > 1 LIMIT 1`,
    [columnId]
  );
  return rows.length > 0;
}

/**
 * Reassign evenly-spaced integer positions to every card in the column,
 * preserving their current order. Restores usable gaps after exhaustion.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let pos = POSITION_STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += POSITION_STEP;
  }
}
