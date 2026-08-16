import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Spacing used when appending cards to the end of a column or when
// renormalizing a column's positions.
const STEP = 1000;

// If two adjacent positions are closer than this, we treat the gap as
// exhausted and renormalize the column to restore clean spacing.
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
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
  };
}

/**
 * Creates a card at the end of a column.
 * @returns {{card: object}}
 */
export async function createCard({ columnId, text }) {
  const db = await getDb();

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

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].maxpos) + STEP;

  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, trimmed, position]
  );

  return { card: serializeCard(rows[0]) };
}

/**
 * Moves a card into a target column, positioned between `afterId` (the card
 * that should end up immediately above it) and `beforeId` (immediately below).
 *
 * The server is authoritative: it computes the canonical position based on the
 * current persisted neighbours, ignoring stale client guesses. Performed in a
 * single transaction so no client can ever observe the card in two columns.
 *
 * If the computed gap is exhausted (positions collide or precision runs out),
 * the target column is renormalized and the corrected order is returned so it
 * can be broadcast.
 *
 * @returns {{card: object, columnId: string, normalized?: object[]}}
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  const db = await getDb();

  return db.transaction(async (tx) => {
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

    // Resolve the canonical bounding positions from neighbours that actually
    // exist in the target column (excluding the card being moved).
    const afterPos = await neighbourPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighbourPosition(tx, columnId, beforeId, cardId);

    let lower; // position immediately above the slot
    let upper; // position immediately below the slot

    if (afterPos !== null && beforePos !== null) {
      lower = afterPos;
      upper = beforePos;
    } else if (afterPos !== null) {
      // Insert after a known card -> use next existing card as upper bound.
      lower = afterPos;
      upper = await nextPositionAbove(tx, columnId, afterPos, cardId);
    } else if (beforePos !== null) {
      // Insert before a known card -> use previous existing card as lower.
      upper = beforePos;
      lower = await prevPositionBelow(tx, columnId, beforePos, cardId);
    } else {
      // No usable neighbours: append to end of the target column.
      lower = await maxPosition(tx, columnId, cardId);
      upper = null;
    }

    let newPosition = computeBetween(lower, upper);
    let needsRenormalize = false;

    if (lower !== null && upper !== null) {
      // Guard against exhausted gaps / collisions.
      if (
        upper - lower < MIN_GAP ||
        newPosition <= lower ||
        newPosition >= upper
      ) {
        needsRenormalize = true;
      }
    }

    // Apply the move first (so the moved card participates in renormalization).
    await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      newPosition,
      cardId,
    ]);

    let normalized;
    if (needsRenormalize) {
      normalized = await renormalizeColumn(tx, columnId);
      // Re-read the moved card's canonical position after renormalization.
      const { rows } = await tx.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );
      return {
        card: serializeCard(rows[0]),
        columnId,
        normalized,
      };
    }

    const { rows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    return { card: serializeCard(rows[0]), columnId };
  });
}

async function neighbourPosition(tx, columnId, neighbourId, movingId) {
  if (!neighbourId || neighbourId === movingId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighbourId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

async function nextPositionAbove(tx, columnId, pos, excludeId) {
  const { rows } = await tx.query(
    `SELECT position FROM cards
      WHERE column_id = $1 AND position > $2 AND id <> $3
   ORDER BY position ASC LIMIT 1`,
    [columnId, pos, excludeId]
  );
  return rows.length ? Number(rows[0].position) : null;
}

async function prevPositionBelow(tx, columnId, pos, excludeId) {
  const { rows } = await tx.query(
    `SELECT position FROM cards
      WHERE column_id = $1 AND position < $2 AND id <> $3
   ORDER BY position DESC LIMIT 1`,
    [columnId, pos, excludeId]
  );
  return rows.length ? Number(rows[0].position) : null;
}

async function maxPosition(tx, columnId, excludeId) {
  const { rows } = await tx.query(
    `SELECT MAX(position) AS maxpos FROM cards
      WHERE column_id = $1 AND id <> $2`,
    [columnId, excludeId]
  );
  return rows[0].maxpos === null ? null : Number(rows[0].maxpos);
}

/**
 * Computes a position between lower and upper bounds.
 * - both null   -> first card in an empty column.
 * - lower only  -> append after lower.
 * - upper only  -> prepend before upper.
 * - both        -> midpoint.
 */
function computeBetween(lower, upper) {
  if (lower === null && upper === null) return STEP;
  if (lower === null) return upper - STEP;
  if (upper === null) return lower + STEP;
  return (lower + upper) / 2;
}

/**
 * Rewrites every card in a column to evenly spaced integer positions while
 * preserving current order. Returns the canonical ordered card list.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1
   ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );

  let pos = STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += STEP;
  }

  const { rows: updated } = await tx.query(
    `SELECT id, column_id, text, position, created_at FROM cards
      WHERE column_id = $1
   ORDER BY position ASC`,
    [columnId]
  );
  return updated.map(serializeCard);
}
