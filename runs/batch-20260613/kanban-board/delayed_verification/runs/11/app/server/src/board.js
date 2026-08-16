import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { computePosition, POSITION_STEP } from './ordering.js';

/**
 * Fetch the full board: ordered columns, each with its cards ordered by
 * position (ties broken deterministically by created_at then id so ordering
 * is total and stable).
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
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }
  return columns.map((c) => byColumn.get(c.id));
}

export function serializeCard(card) {
  return {
    id: card.id,
    columnId: card.column_id,
    text: card.text,
    position: Number(card.position),
    createdAt: card.created_at,
  };
}

/**
 * Create a card at the end of a column.
 */
export async function createCard(columnId, text) {
  const db = getDb();

  const { rows: colRows } = await db.query(
    'SELECT id FROM columns WHERE id = $1',
    [columnId]
  );
  if (colRows.length === 0) {
    const err = new Error('Column not found');
    err.status = 404;
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = maxRows[0].max_pos;
  const position =
    maxPos === null || maxPos === undefined
      ? POSITION_STEP
      : Number(maxPos) + POSITION_STEP;

  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, text, position]
  );
  return serializeCard(rows[0]);
}

/**
 * Move a card into `columnId`, positioned between `afterId` and `beforeId`.
 *
 * The whole operation runs in a single transaction so that the card is never
 * observable in two columns. Returns:
 *   { card, renormalized: boolean, column }
 * where `column` is the canonical ordering of the target column after the move
 * (always included so clients can fully reconcile; required when a
 * renormalization occurred).
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const db = getDb();

  let result;
  await db.transaction(async (tx) => {
    // Lock-free under PGLite's single connection, but we still do everything
    // inside one transaction so only committed state is ever broadcast.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    // Resolve neighbour positions from authoritative DB state, ignoring the
    // moved card itself (it might currently sit in the target column).
    const afterPos = await neighbourPosition(tx, columnId, afterId, cardId);
    const beforePos = await neighbourPosition(tx, columnId, beforeId, cardId);

    const { position } = computePosition(afterPos, beforePos);

    // A computed position is unusable when (a) the neighbour gap is exhausted
    // (position === null) or (b) the value collides with a card already in the
    // column. Either way we renormalize the whole column and place the moved
    // card right after `afterId`, guaranteeing a total, collision-free order.
    const collides =
      position !== null && (await positionTaken(tx, columnId, position, cardId));

    let renormalized = false;
    if (position === null || collides) {
      // Move the card into the target column first (out of its source), then
      // renormalize to evenly spaced integers with deterministic placement.
      await tx.query(
        'UPDATE cards SET column_id = $1 WHERE id = $2',
        [columnId, cardId]
      );
      await renormalizeColumn(tx, columnId, {
        movedId: cardId,
        afterId: afterId || null,
      });
      renormalized = true;
    } else {
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, position, cardId]
      );
    }

    const { rows: updated } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );

    const column = await columnSnapshot(tx, columnId);

    result = {
      card: serializeCard(updated[0]),
      renormalized,
      column,
    };
  });

  return result;
}

/**
 * Resolve the position of a neighbour card within a column. Returns null when
 * no neighbour id is given or the neighbour can't be found in that column.
 * Excludes `excludeId` (the card being moved) so a card that's already in the
 * target column doesn't act as its own neighbour.
 */
async function neighbourPosition(tx, columnId, neighbourId, excludeId) {
  if (!neighbourId) return null;
  const { rows } = await tx.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id <> $3',
    [neighbourId, columnId, excludeId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}

/**
 * True when some card (other than `excludeId`) in the column already occupies
 * exactly `position` — i.e. assigning it would create a collision.
 */
async function positionTaken(tx, columnId, position, excludeId) {
  const { rows } = await tx.query(
    'SELECT 1 FROM cards WHERE column_id = $1 AND position = $2 AND id <> $3 LIMIT 1',
    [columnId, position, excludeId]
  );
  return rows.length > 0;
}

/**
 * Reassign evenly spaced positions to every card in a column, preserving the
 * current ordering (position, created_at, id).
 *
 * When `place = { movedId, afterId }` is provided, the moved card is removed
 * from its current slot and reinserted immediately after `afterId` (or at the
 * very start when `afterId` is null) before positions are reassigned. This
 * lets us deterministically resolve a precision-exhaustion move.
 */
async function renormalizeColumn(tx, columnId, place = null) {
  const { rows } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let ids = rows.map((r) => r.id);

  if (place && place.movedId) {
    ids = ids.filter((id) => id !== place.movedId);
    if (place.afterId) {
      const idx = ids.indexOf(place.afterId);
      ids.splice(idx === -1 ? ids.length : idx + 1, 0, place.movedId);
    } else {
      ids.unshift(place.movedId);
    }
  }

  let pos = POSITION_STEP;
  for (const id of ids) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, id]);
    pos += POSITION_STEP;
  }
}

async function columnSnapshot(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  return {
    columnId,
    cards: rows.map(serializeCard),
  };
}
