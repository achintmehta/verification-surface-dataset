import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Spacing between consecutive positions used when appending or renormalizing.
const POSITION_STEP = 1024;
// Minimum gap between two adjacent positions before we consider precision
// effectively exhausted and trigger a renormalization of the column.
const MIN_GAP = 1e-6;

/**
 * Returns the full board: every column (ordered by position) each carrying its
 * cards (ordered by position).
 */
export async function getBoard() {
  const db = await getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id ASC, position ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }

  return { columns: Array.from(byColumn.values()) };
}

async function columnExists(db, columnId) {
  const { rows } = await db.query('SELECT 1 FROM columns WHERE id = $1', [columnId]);
  return rows.length > 0;
}

async function getCard(db, id) {
  const { rows } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

/**
 * Creates a card at the end of the given column.
 * Returns the canonical card row.
 */
export async function createCard({ columnId, text }) {
  const db = await getDb();
  if (!columnId) throw new HttpError(400, 'columnId is required');
  const trimmed = (text ?? '').toString().trim();
  if (!trimmed) throw new HttpError(400, 'text is required');
  if (!(await columnExists(db, columnId))) {
    throw new HttpError(404, 'column not found');
  }

  // Position at the end of the column = (max position) + STEP.
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(rows[0].max_pos) + POSITION_STEP;
  const id = randomUUID();

  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, trimmed, position]
  );

  return await getCard(db, id);
}

/**
 * Computes a fractional position for a card placed between `afterId` (the card
 * directly above the drop slot) and `beforeId` (the card directly below it),
 * within `columnId`. Either may be null/undefined to indicate top or bottom.
 *
 * Returns { position, needsRenormalize }.
 */
function computeMidpoint(prevPos, nextPos) {
  if (prevPos == null && nextPos == null) {
    // Empty column.
    return { position: POSITION_STEP, needsRenormalize: false };
  }
  if (prevPos == null) {
    // Insert at top: before the first card.
    return { position: nextPos - POSITION_STEP, needsRenormalize: false };
  }
  if (nextPos == null) {
    // Insert at bottom: after the last card.
    return { position: prevPos + POSITION_STEP, needsRenormalize: false };
  }
  const gap = nextPos - prevPos;
  if (gap <= MIN_GAP) {
    // Precision exhausted / collision: caller must renormalize.
    return { position: (prevPos + nextPos) / 2, needsRenormalize: true };
  }
  return { position: prevPos + gap / 2, needsRenormalize: false };
}

/**
 * Renormalizes all cards in a column to evenly spaced integer positions,
 * preserving their current visual order. Run inside an open transaction.
 * Returns the ordered list of cards after renormalization.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: ordered } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );
  for (let i = 0; i < ordered.length; i++) {
    const newPos = (i + 1) * POSITION_STEP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, ordered[i].id]);
  }
}

/**
 * Moves a card into `columnId` between `afterId` and `beforeId`, computing the
 * canonical position. The whole operation runs in a single transaction so no
 * client can ever observe the card in two columns, and broadcasts only reflect
 * committed state.
 *
 * Returns { card, renormalizedColumns: { [columnId]: orderedCards } }.
 * When a renormalization occurs, the corrected order is included so callers can
 * broadcast it.
 */
export async function moveCard({ id, columnId, beforeId, afterId }) {
  const db = await getDb();

  if (!id) throw new HttpError(400, 'card id is required');
  if (!columnId) throw new HttpError(400, 'columnId is required');

  await db.query('BEGIN');
  try {
    const card = await getCard(db, id);
    if (!card) {
      throw new HttpError(404, 'card not found');
    }
    if (!(await columnExists(db, columnId))) {
      throw new HttpError(404, 'column not found');
    }

    // Resolve neighbor positions. We deliberately read them inside the
    // transaction so that the midpoint reflects committed state. Neighbors that
    // point at the card being moved, or that belong to another column, are
    // ignored (the client's optimistic guess may be stale).
    const afterPos = await neighborPosition(db, afterId, columnId, id);
    const beforePos = await neighborPosition(db, beforeId, columnId, id);

    let prevPos = afterPos;
    let nextPos = beforePos;

    // Guard against inconsistent neighbor ordering (stale client guess): if the
    // "after" card actually sits below the "before" card, ignore the bounds and
    // fall back to a renormalize-safe midpoint.
    if (prevPos != null && nextPos != null && prevPos >= nextPos) {
      const tmp = prevPos;
      prevPos = nextPos;
      nextPos = tmp;
    }

    const { position, needsRenormalize } = computeMidpoint(prevPos, nextPos);

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, position, id]
    );

    const renormalizedColumns = {};

    if (needsRenormalize) {
      await renormalizeColumn(db, columnId);
    }

    // Also detect duplicate positions in the target column (collision) and
    // renormalize defensively.
    if (!needsRenormalize && (await hasPositionCollision(db, columnId))) {
      await renormalizeColumn(db, columnId);
    }

    await db.query('COMMIT');

    // After commit, read back canonical state for broadcasting.
    const canonicalCard = await getCard(db, id);

    // Always report the (possibly renormalized) ordering of the target column,
    // and of the source column if it changed, so clients converge exactly.
    renormalizedColumns[columnId] = await orderedColumnCards(db, columnId);
    if (card.column_id !== columnId) {
      renormalizedColumns[card.column_id] = await orderedColumnCards(db, card.column_id);
    }

    return { card: canonicalCard, columns: renormalizedColumns };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function neighborPosition(db, neighborId, columnId, movingId) {
  if (!neighborId || neighborId === movingId) return null;
  const { rows } = await db.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [neighborId, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

async function hasPositionCollision(db, columnId) {
  const { rows } = await db.query(
    `SELECT position, COUNT(*)::int AS c
       FROM cards WHERE column_id = $1
      GROUP BY position HAVING COUNT(*) > 1
      LIMIT 1`,
    [columnId]
  );
  return rows.length > 0;
}

async function orderedColumnCards(db, columnId) {
  const { rows } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return rows;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
