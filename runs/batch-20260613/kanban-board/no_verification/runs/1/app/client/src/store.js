/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) and provides
 * mutation helpers used by both the optimistic UI and SSE reconciliation.
 *
 * All state is kept in plain JS objects; the UI layer reads from here
 * and re-renders as needed.
 */

/** @type {{ id: string, title: string, position: number, cards: Card[] }[]} */
let columns = [];

/** Fast lookup: cardId → card object */
const cardMap = new Map();

/** Fast lookup: columnId → column object */
const columnMap = new Map();

/* ── Initialise ─────────────────────────────────────────────────────── */

/**
 * Replace the entire board state (called on initial load and full refresh).
 * @param {{ columns: Array }} board
 */
export function setBoard(board) {
  columns = board.columns.map((col) => ({
    ...col,
    cards: [...col.cards],
  }));

  cardMap.clear();
  columnMap.clear();

  for (const col of columns) {
    columnMap.set(col.id, col);
    for (const card of col.cards) {
      cardMap.set(card.id, card);
    }
  }
}

/* ── Reads ──────────────────────────────────────────────────────────── */

export function getColumns() {
  return columns;
}

export function getColumn(id) {
  return columnMap.get(id) ?? null;
}

export function getCard(id) {
  return cardMap.get(id) ?? null;
}

/* ── Mutations ──────────────────────────────────────────────────────── */

/**
 * Add a new card to the store (optimistic or from SSE).
 * If the card already exists it is updated in place.
 * @param {object} card
 */
export function upsertCard(card) {
  const existing = cardMap.get(card.id);

  if (existing) {
    // Card exists — update fields and move between columns if needed
    const oldCol = columnMap.get(existing.column_id);
    const newCol = columnMap.get(card.column_id);

    if (oldCol && oldCol !== newCol) {
      // Remove from old column
      oldCol.cards = oldCol.cards.filter((c) => c.id !== card.id);
    }

    Object.assign(existing, card);

    if (newCol && !newCol.cards.find((c) => c.id === card.id)) {
      newCol.cards.push(existing);
    }

    sortColumn(card.column_id);
  } else {
    // New card
    const col = columnMap.get(card.column_id);
    if (!col) return; // unknown column — ignore

    const newCard = { ...card };
    cardMap.set(card.id, newCard);
    col.cards.push(newCard);
    sortColumn(card.column_id);
  }
}

/**
 * Apply a renormalization result: update positions for a set of cards.
 * @param {Array<{ id: string, position: number }>} renormedCards
 * @param {string} columnId
 */
export function applyRenorm(renormedCards, columnId) {
  for (const { id, position } of renormedCards) {
    const card = cardMap.get(id);
    if (card) card.position = position;
  }
  sortColumn(columnId);
}

/**
 * Sort a column's cards array by position ascending.
 * @param {string} columnId
 */
export function sortColumn(columnId) {
  const col = columnMap.get(columnId);
  if (col) {
    col.cards.sort((a, b) => a.position - b.position);
  }
}

/**
 * Optimistically move a card: update column_id and position in the store
 * without waiting for the server. Returns the previous state so it can be
 * rolled back if the server rejects the move.
 *
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {number} optimisticPosition
 * @returns {{ prevColumnId: string, prevPosition: number } | null}
 */
export function optimisticMove(cardId, targetColumnId, optimisticPosition) {
  const card = cardMap.get(cardId);
  if (!card) return null;

  const prevColumnId = card.column_id;
  const prevPosition = card.position;

  // Remove from old column
  const oldCol = columnMap.get(prevColumnId);
  if (oldCol) {
    oldCol.cards = oldCol.cards.filter((c) => c.id !== cardId);
  }

  // Update card
  card.column_id = targetColumnId;
  card.position = optimisticPosition;

  // Add to new column
  const newCol = columnMap.get(targetColumnId);
  if (newCol) {
    newCol.cards.push(card);
    sortColumn(targetColumnId);
  }

  return { prevColumnId, prevPosition };
}

/**
 * Roll back an optimistic move.
 * @param {string} cardId
 * @param {string} prevColumnId
 * @param {number} prevPosition
 */
export function rollbackMove(cardId, prevColumnId, prevPosition) {
  const card = cardMap.get(cardId);
  if (!card) return;

  const currentCol = columnMap.get(card.column_id);
  if (currentCol) {
    currentCol.cards = currentCol.cards.filter((c) => c.id !== cardId);
  }

  card.column_id = prevColumnId;
  card.position = prevPosition;

  const prevCol = columnMap.get(prevColumnId);
  if (prevCol) {
    prevCol.cards.push(card);
    sortColumn(prevColumnId);
  }
}
