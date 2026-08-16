import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Default gap used when appending cards to a column or normalizing positions.
const POSITION_STEP = 1024;
// Minimum gap between two fractional positions before we consider precision
// exhausted and renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Returns the full board: ordered columns, each with their cards ordered by
 * position. This is the authoritative board state.
 */
export async function getBoard() {
  const db = await getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position ASC, created_at ASC'
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }

  return { columns: Array.from(byColumn.values()) };
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
 * Creates a card appended to the end of a column.
 * Returns the canonical serialized card.
 */
export async function createCard({ columnId, text }) {
  const db = await getDb();

  // Validate the target column exists.
  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error(`Unknown column: ${columnId}`);
    err.status = 400;
    throw err;
  }

  const cleanText = String(text ?? '').trim();
  if (!cleanText) {
    const err = new Error('Card text is required');
    err.status = 400;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = maxRows[0].max == null ? 0 : Number(maxRows[0].max);
  const position = maxPos + POSITION_STEP;

  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, cleanText, position]
  );

  return serializeCard(rows[0]);
}

/**
 * Moves a card into `columnId`, placing it between the cards identified by
 * `afterId` (the card that should come before it) and `beforeId` (the card
 * that should come after it). The server computes the canonical fractional
 * position and applies it atomically.
 *
 * If a collision or precision exhaustion is detected, the affected column is
 * renormalized; in that case `renormalized` is true and `affectedColumnId`
 * carries the corrected order.
 *
 * @returns {{ card: object, renormalized: boolean, affectedColumnId: string }}
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = await getDb();

  let result;
  await db.transaction(async (tx) => {
    // Lock-free correctness in PGlite (single connection) is fine; PGlite is
    // serial, so the transaction body runs atomically with respect to other
    // mutations.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
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

    // Resolve the bounding positions from the neighbor cards. We read them
    // *excluding* the card being moved so self-references are ignored.
    const afterPos = await neighborPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighborPosition(tx, columnId, beforeId, cardId);

    let lower = afterPos; // position of the card that should precede us
    let upper = beforePos; // position of the card that should follow us

    let newPosition;
    if (lower == null && upper == null) {
      // Empty target column (besides possibly this card).
      newPosition = POSITION_STEP;
    } else if (lower == null) {
      // Insert at the very top.
      newPosition = upper - POSITION_STEP;
    } else if (upper == null) {
      // Insert at the very bottom.
      newPosition = lower + POSITION_STEP;
    } else {
      newPosition = (lower + upper) / 2;
    }

    // Detect collision / precision exhaustion: the computed slot is too tight
    // to be representable distinctly from its neighbors.
    const tooTight =
      (lower != null && Math.abs(newPosition - lower) < MIN_GAP) ||
      (upper != null && Math.abs(upper - newPosition) < MIN_GAP) ||
      !Number.isFinite(newPosition);

    // Apply the move first (so the card belongs to the target column), then
    // renormalize the entire column if needed to guarantee a total, stable,
    // collision-free order.
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    let renormalized = false;
    if (tooTight) {
      // Renormalize: re-space all cards in the target column with even gaps,
      // preserving their current relative order (which now includes the moved
      // card at its intended slot).
      await renormalizeColumn(tx, columnId);
      renormalized = true;
    }

    const { rows: finalRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );

    result = {
      card: serializeCard(finalRows[0]),
      renormalized,
      affectedColumnId: columnId,
    };
  });

  return result;
}

/**
 * Resolves the position of a neighbor card within a column, ignoring the card
 * currently being moved. Returns null when the neighbor id is absent or does
 * not belong to the column.
 */
async function neighborPosition(tx, columnId, neighborId, movingCardId) {
  if (!neighborId || neighborId === movingCardId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * Re-spaces every card in a column with even POSITION_STEP gaps, preserving
 * the existing order by current position. Runs inside the provided tx.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards
     WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let pos = POSITION_STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += POSITION_STEP;
  }
}

/**
 * Returns the ordered card list for a single column (used to broadcast a
 * corrected order after renormalization).
 */
export async function getColumnCards(columnId) {
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards WHERE column_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return rows.map(serializeCard);
}
