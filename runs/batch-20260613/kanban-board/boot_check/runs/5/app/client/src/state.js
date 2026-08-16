/**
 * Client-side board state.
 *
 * The state is a Map<columnId, { id, title, position, cards: Card[] }>
 * where cards are kept sorted by position ASC.
 *
 * All mutations go through the helpers below so the sort invariant is
 * always maintained.
 */

/** @type {Map<string, Column>} */
let columns = new Map();

/* ------------------------------------------------------------------ */
/*  Initialise                                                          */
/* ------------------------------------------------------------------ */

/**
 * Replace the entire board state from the server's GET /api/board response.
 * @param {Array} boardData
 */
export function initState(boardData) {
  columns = new Map();
  for (const col of boardData) {
    columns.set(col.id, {
      id:       col.id,
      title:    col.title,
      position: col.position,
      cards:    [...col.cards].sort(byPosition),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Reads                                                               */
/* ------------------------------------------------------------------ */

/** @returns {Column[]} columns sorted by position */
export function getColumns() {
  return [...columns.values()].sort(byPosition);
}

/** @returns {Column|undefined} */
export function getColumn(columnId) {
  return columns.get(columnId);
}

/** @returns {Card|undefined} */
export function getCard(cardId) {
  for (const col of columns.values()) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Upsert a card into the correct column, removing it from any other column.
 * Used for both optimistic updates and server reconciliation.
 * @param {Card} card
 */
export function upsertCard(card) {
  // Remove from any existing column
  for (const col of columns.values()) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Insert into target column
  const col = columns.get(card.column_id);
  if (!col) {
    console.warn('[state] upsertCard: unknown column', card.column_id);
    return;
  }
  col.cards.push(card);
  col.cards.sort(byPosition);
}

/**
 * Replace all cards in a column (used after renormalization broadcast).
 * @param {string} columnId
 * @param {Card[]} cards
 */
export function replaceColumnCards(columnId, cards) {
  const col = columns.get(columnId);
  if (!col) return;
  col.cards = [...cards].sort(byPosition);
}

/**
 * Optimistically move a card to a new position without a server-computed
 * position value.  We assign a synthetic position between its new neighbours
 * so the sort order is correct until the server responds.
 *
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string|null} beforeId  card above the drop target (null = top)
 * @param {string|null} afterId   card below the drop target (null = bottom)
 * @returns {Card|null} the optimistically updated card, or null if not found
 */
export function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  const card = getCard(cardId);
  if (!card) return null;

  const targetCol = columns.get(targetColumnId);
  if (!targetCol) return null;

  // Compute a synthetic position between neighbours
  const beforeCard = beforeId ? targetCol.cards.find((c) => c.id === beforeId) : null;
  const afterCard  = afterId  ? targetCol.cards.find((c) => c.id === afterId)  : null;

  let syntheticPos;
  if (!beforeCard && !afterCard) {
    syntheticPos = 1;
  } else if (!beforeCard) {
    syntheticPos = afterCard.position - 0.5;
  } else if (!afterCard) {
    syntheticPos = beforeCard.position + 0.5;
  } else {
    syntheticPos = (beforeCard.position + afterCard.position) / 2;
  }

  const optimisticCard = { ...card, column_id: targetColumnId, position: syntheticPos };
  upsertCard(optimisticCard);
  return optimisticCard;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function byPosition(a, b) {
  return a.position - b.position;
}
