import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Spacing used when appending to the end of a column or when renormalizing.
const POSITION_STEP = 1000;
// If two adjacent positions are closer than this, we consider precision
// exhausted and renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Returns the full board: ordered columns, each with its ordered cards.
 */
export async function getBoard() {
  const db = await getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position,
            extract(epoch from created_at) AS created_at
     FROM cards
     ORDER BY column_id ASC, position ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }
  return { columns: columns.map((c) => byColumn.get(c.id)) };
}

function serializeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at ? Number(row.created_at) : null,
  };
}

/**
 * Creates a new card at the end of the given column.
 * Returns the canonical card.
 */
export async function createCard({ columnId, text }) {
  const db = await getDb();
  const trimmed = (text ?? '').toString().trim();
  if (!trimmed) {
    throw new ApiError(400, 'Card text is required');
  }

  // Validate column exists.
  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    throw new ApiError(404, 'Column not found');
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].maxpos) + POSITION_STEP;
  const id = randomUUID();

  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position,
               extract(epoch from created_at) AS created_at`,
    [id, columnId, trimmed, position]
  );
  return serializeCard(rows[0]);
}

/**
 * Moves a card into `columnId` between `afterId` (the card above the drop slot)
 * and `beforeId` (the card below the drop slot). Computes the canonical
 * fractional position atomically. If positions collide or precision is
 * exhausted, the target column is renormalized.
 *
 * Returns { card, renormalized } where `card` is the canonical moved card and
 * `renormalized` (when present) is the full ordered card list for the column.
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  const db = await getDb();

  return db.transaction(async (tx) => {
    // Lock the card row being moved.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id FROM cards WHERE id = $1 FOR UPDATE',
      [cardId]
    );
    if (cardRows.length === 0) {
      throw new ApiError(404, 'Card not found');
    }

    // Validate target column.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      throw new ApiError(404, 'Target column not found');
    }

    // Resolve neighbour positions inside the target column. We ignore the
    // moved card itself (it may currently be in this column).
    const afterPos = await neighbourPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighbourPosition(tx, columnId, beforeId, cardId);

    let position = computePosition(afterPos, beforePos);
    let needsRenormalize = position === null;

    if (!needsRenormalize) {
      // Move the card atomically (remove from source + place in target are the
      // same UPDATE, so it can never exist in two columns).
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, position, cardId]
      );

      // Detect collisions: did another card end up with the identical position?
      const { rows: dupRows } = await tx.query(
        'SELECT COUNT(*)::int AS count FROM cards WHERE column_id = $1 AND position = $2',
        [columnId, position]
      );
      if (dupRows[0].count > 1) {
        needsRenormalize = true;
      }
    }

    if (needsRenormalize) {
      // Place the moved card into the column first (if not already computed)
      // using a temporary position derived from its neighbours, then
      // renormalize the entire column to evenly spaced integers.
      const tempPos = pickTempPosition(afterPos, beforePos);
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, tempPos, cardId]
      );
      const order = await renormalizeColumn(tx, columnId, cardId, afterId, beforeId);

      const moved = order.find((c) => c.id === cardId);
      return { card: moved, renormalized: { columnId, cards: order } };
    }

    const { rows } = await tx.query(
      `SELECT id, column_id, text, position,
              extract(epoch from created_at) AS created_at
       FROM cards WHERE id = $1`,
      [cardId]
    );
    return { card: serializeCard(rows[0]), renormalized: null };
  });
}

/**
 * Looks up the position of a neighbour card within a column. Returns null if
 * the neighbour id is null/missing or not in this column.
 */
async function neighbourPosition(tx, columnId, neighbourId, movingCardId) {
  if (!neighbourId || neighbourId === movingCardId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighbourId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Computes a fractional position between afterPos (above) and beforePos
 * (below). Returns null when there is no usable gap (precision exhausted),
 * signalling that the column must be renormalized.
 */
function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // Empty column.
    return POSITION_STEP;
  }
  if (afterPos == null) {
    // Insert at the very top.
    return beforePos - POSITION_STEP;
  }
  if (beforePos == null) {
    // Insert at the very bottom.
    return afterPos + POSITION_STEP;
  }
  if (beforePos - afterPos <= MIN_GAP) {
    return null; // No room; renormalize.
  }
  return afterPos + (beforePos - afterPos) / 2;
}

function pickTempPosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return POSITION_STEP;
  if (afterPos == null) return beforePos - MIN_GAP / 2;
  if (beforePos == null) return afterPos + MIN_GAP / 2;
  return afterPos + (beforePos - afterPos) / 2;
}

/**
 * Renormalizes a column's card positions to evenly spaced integers while
 * preserving the current visual order. The moved card is positioned so it
 * lands between afterId and beforeId. Returns the ordered serialized cards.
 */
async function renormalizeColumn(tx, columnId, movedId, afterId, beforeId) {
  // Fetch current order. Tie-break deterministically so concurrent identical
  // positions still yield a total order.
  const { rows } = await tx.query(
    `SELECT id, column_id, text, position,
            extract(epoch from created_at) AS created_at
     FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );

  // Rebuild the desired order, explicitly placing the moved card relative to
  // its requested neighbours to keep the user's intent.
  const others = rows.filter((r) => r.id !== movedId);
  const movedRow = rows.find((r) => r.id === movedId);
  const ordered = [];
  let inserted = false;

  if (!afterId && !beforeId) {
    // No neighbours specified: append at end.
    ordered.push(...others);
    if (movedRow) ordered.push(movedRow);
    inserted = true;
  } else {
    for (const row of others) {
      if (row.id === beforeId && !inserted) {
        if (movedRow) ordered.push(movedRow);
        inserted = true;
      }
      ordered.push(row);
      if (row.id === afterId && !inserted) {
        if (movedRow) ordered.push(movedRow);
        inserted = true;
      }
    }
    if (!inserted && movedRow) {
      ordered.push(movedRow);
    }
  }

  // Assign evenly spaced positions.
  let pos = POSITION_STEP;
  const result = [];
  for (const row of ordered) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    result.push(serializeCard({ ...row, position: pos }));
    pos += POSITION_STEP;
  }
  return result;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
