import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import {
  computePosition,
  renormalizedPositions,
  DEFAULT_GAP,
} from './ordering.js';

/**
 * Return the full board: every column (ordered by position) with its cards
 * (ordered by position).
 */
export async function getBoard() {
  const db = await getDb();
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY position ASC, created_at ASC, id ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, []);
  }
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
 * Create a card at the end of a column.
 * Returns the serialized canonical card.
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
  const maxPos = maxRows[0].max;
  const position =
    maxPos === null || maxPos === undefined
      ? DEFAULT_GAP
      : Number(maxPos) + DEFAULT_GAP;

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
 * Move a card into `columnId`, placing it between `afterId` (the card that
 * should sit above it) and `beforeId` (the card that should sit below it).
 *
 * The whole operation runs inside a single transaction so the card is never
 * observed in two columns. If fractional precision is exhausted, the target
 * column is renormalized inside the same transaction.
 *
 * Returns { card, column } where `card` is the canonical moved card and
 * `column` is the canonical ordered list of the target column's cards (used so
 * clients can reconcile renormalizations). If a renormalization of the *source*
 * column occurred it is not needed because removing a card never collides.
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  const db = await getDb();

  let result;
  await db.transaction(async (tx) => {
    // Lock / fetch the moving card.
    const { rows: cardRows } = await tx.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error(`Unknown card: ${cardId}`);
      err.status = 404;
      throw err;
    }

    // Validate the target column exists.
    const { rows: colRows } = await tx.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      const err = new Error(`Unknown column: ${columnId}`);
      err.status = 400;
      throw err;
    }

    // Read the neighbour positions from the target column. We ignore the moving
    // card itself in case it is already in this column (intra-column reorder).
    let afterPos = null;
    let beforePos = null;

    if (afterId && afterId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (rows.length > 0) afterPos = Number(rows[0].position);
    }
    if (beforeId && beforeId !== cardId) {
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (rows.length > 0) beforePos = Number(rows[0].position);
    }

    const { position, needsRenormalize } = computePosition(afterPos, beforePos);

    // Apply the move (this both reparents the card and sets its position).
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, position, cardId]
    );

    if (needsRenormalize) {
      await renormalizeColumn(tx, columnId, {
        cardId,
        afterId,
        beforeId,
      });
    }

    // Read back the canonical target column ordering and the moved card.
    const { rows: columnCards } = await tx.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        WHERE column_id = $1
        ORDER BY position ASC, created_at ASC, id ASC`,
      [columnId]
    );

    const movedRow = columnCards.find((c) => c.id === cardId);
    result = {
      card: serializeCard(movedRow),
      column: {
        id: columnId,
        cards: columnCards.map(serializeCard),
      },
    };
  });

  return result;
}

/**
 * Renormalize the positions of every card in a column to evenly spaced values,
 * preserving the intended order. The moving card (cardId) is positioned
 * relative to afterId/beforeId; everything else keeps its current relative
 * order.
 */
async function renormalizeColumn(tx, columnId, { cardId, afterId, beforeId }) {
  // Fetch current ordering. The moving card currently has a (possibly colliding)
  // position; we rebuild a clean ordered list that honours the requested
  // neighbours and then assign evenly spaced positions.
  const { rows } = await tx.query(
    `SELECT id, position FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );

  // Build an explicit order: place the moving card right after `afterId`
  // (or at the start if there is no afterId / it should be first).
  const others = rows.map((r) => r.id).filter((id) => id !== cardId);

  let ordered;
  if (afterId && others.includes(afterId)) {
    const idx = others.indexOf(afterId);
    ordered = [
      ...others.slice(0, idx + 1),
      cardId,
      ...others.slice(idx + 1),
    ];
  } else if (beforeId && others.includes(beforeId)) {
    const idx = others.indexOf(beforeId);
    ordered = [...others.slice(0, idx), cardId, ...others.slice(idx)];
  } else if (!afterId) {
    // Insert at the top.
    ordered = [cardId, ...others];
  } else {
    // afterId not present (e.g. at the end) -> append.
    ordered = [...others, cardId];
  }

  const positions = renormalizedPositions(ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
      positions[i],
      ordered[i],
    ]);
  }
}
