import { db } from './db.js';
import { broadcast } from './sse.js';

// Step used when appending to the end of a column.
const POSITION_STEP = 1000;
// Minimum gap between two positions before we consider precision exhausted.
const MIN_GAP = 1e-6;

/**
 * Fetch a single card row by id.
 */
async function getCard(id) {
  const res = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/**
 * Fetch all cards in a column ordered by position then id (stable, total order).
 */
async function getColumnCards(columnId) {
  const res = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  return res.rows;
}

/**
 * Create a card at the end of a column.
 * Persists and broadcasts. Returns the canonical card.
 */
export async function createCard(columnId, text) {
  const cards = await getColumnCards(columnId);
  const last = cards[cards.length - 1];
  const position = last ? last.position + POSITION_STEP : POSITION_STEP;

  const res = await db.query(
    'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING *',
    [columnId, text, position]
  );
  const card = res.rows[0];
  broadcast('card:create', { card });
  return card;
}

/**
 * Renormalize all positions in a column to evenly spaced integers.
 * Runs inside an existing transaction (the caller must manage tx).
 * Returns the renormalized, ordered list of cards.
 */
async function renormalizeColumn(columnId) {
  const cards = await getColumnCards(columnId);
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_STEP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      newPos,
      cards[i].id
    ]);
    cards[i].position = newPos;
  }
  return cards;
}

/**
 * Compute a target position for a card moving into a column, placed between
 * the cards identified by afterId (the card above the drop point) and
 * beforeId (the card below the drop point).
 *
 * Returns { position } or { needsRenormalize: true } when the gap is exhausted.
 */
function computePosition(orderedCards, afterId, beforeId, movingId) {
  // Filter out the moving card from the reference list (it may already be in this column).
  const refs = orderedCards.filter((c) => c.id !== movingId);

  const afterCard = afterId != null ? refs.find((c) => c.id === afterId) : null;
  const beforeCard =
    beforeId != null ? refs.find((c) => c.id === beforeId) : null;

  let lower; // position above (smaller)
  let upper; // position below (larger)

  if (afterCard) {
    lower = afterCard.position;
  } else {
    // No card above => placing at the top: lower is below the first ref.
    lower = refs.length > 0 ? refs[0].position - POSITION_STEP : 0;
  }

  if (beforeCard) {
    upper = beforeCard.position;
  } else {
    // No card below => placing at the bottom: above the last ref.
    upper =
      refs.length > 0 ? refs[refs.length - 1].position + POSITION_STEP : POSITION_STEP;
  }

  // If references are inconsistent (e.g. stale ids), fall back to append.
  if (lower >= upper) {
    return { needsRenormalize: true };
  }

  const position = (lower + upper) / 2;

  // Precision exhaustion: midpoint collides with a neighbor.
  if (position - lower < MIN_GAP || upper - position < MIN_GAP) {
    return { needsRenormalize: true };
  }

  return { position };
}

/**
 * Move a card into a column between afterId and beforeId.
 * Atomic: removes from source and places in target within a single transaction.
 * Renormalizes the target column on collision/exhaustion and broadcasts the
 * corrected order.
 *
 * Returns { card, renormalizedColumn } where renormalizedColumn is the column
 * id whose full order was renormalized (or null).
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  let result;

  await db.transaction(async (tx) => {
    const cardRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardRes.rows[0];
    if (!card) {
      const err = new Error('Card not found');
      err.statusCode = 404;
      throw err;
    }

    const colRes = await tx.query('SELECT id FROM columns WHERE id = $1', [
      columnId
    ]);
    if (colRes.rows.length === 0) {
      const err = new Error('Column not found');
      err.statusCode = 400;
      throw err;
    }

    // Current ordered cards in the *target* column.
    const targetRes = await tx.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
      [columnId]
    );
    const orderedCards = targetRes.rows;

    const computed = computePosition(orderedCards, afterId, beforeId, cardId);

    if (computed.needsRenormalize) {
      // First, move the card into the target column with a temporary position,
      // then renormalize the whole column to a clean, total order.
      // Determine the desired index from the neighbor ids.
      const refs = orderedCards.filter((c) => c.id !== cardId);
      let insertIndex = refs.length; // default: append
      if (afterId != null) {
        const idx = refs.findIndex((c) => c.id === afterId);
        if (idx !== -1) insertIndex = idx + 1;
      } else if (beforeId != null) {
        const idx = refs.findIndex((c) => c.id === beforeId);
        if (idx !== -1) insertIndex = idx;
        else insertIndex = 0;
      } else {
        insertIndex = 0; // no neighbors and not append => top? default append handled above
      }
      if (afterId == null && beforeId == null) {
        insertIndex = refs.length; // truly no info: append
      }

      // Build the new ordering of ids.
      const orderedIds = refs.map((c) => c.id);
      orderedIds.splice(insertIndex, 0, cardId);

      // Move card into the column first (column_id update).
      await tx.query('UPDATE cards SET column_id = $1 WHERE id = $2', [
        columnId,
        cardId
      ]);

      // Assign clean evenly-spaced positions.
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
          (i + 1) * POSITION_STEP,
          orderedIds[i]
        ]);
      }

      result = { renormalized: true, columnId };
    } else {
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, computed.position, cardId]
      );
      result = { renormalized: false, columnId };
    }
  });

  // Read committed state and broadcast.
  const card = await getCard(cardId);

  if (result.renormalized) {
    const cards = await getColumnCards(result.columnId);
    broadcast('column:renormalize', { columnId: result.columnId, cards });
    return { card, renormalizedColumn: result.columnId, columnCards: cards };
  }

  broadcast('card:move', { card });
  return { card, renormalizedColumn: null };
}

/**
 * Return the full board: columns ordered by position, each with ordered cards.
 */
export async function getBoard() {
  const colsRes = await db.query(
    'SELECT * FROM columns ORDER BY position ASC, id ASC'
  );
  const cardsRes = await db.query(
    'SELECT * FROM cards ORDER BY position ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of colsRes.rows) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cardsRes.rows) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }

  return colsRes.rows.map((c) => byColumn.get(c.id));
}
