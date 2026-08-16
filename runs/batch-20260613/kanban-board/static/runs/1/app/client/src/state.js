/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) as received from the
 * server.  Provides helpers to apply server events and to query the state
 * needed by the drag-and-drop layer.
 *
 * All mutations return the new state; the UI layer is responsible for
 * re-rendering after each mutation.
 */

/**
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 * @typedef {{ id: string, title: string, position: number, cards: Card[] }} Column
 * @typedef {{ columns: Column[] }} BoardState
 */

/** @type {BoardState} */
let state = { columns: [] };

/** @returns {BoardState} */
export function getState() {
  return state;
}

/**
 * Replace the entire board state (used on initial load).
 * @param {BoardState} newState
 */
export function setState(newState) {
  state = newState;
}

/**
 * Apply a `card:created` event.
 * Adds the card to the correct column, maintaining position order.
 * @param {Card} card
 */
export function applyCardCreated(card) {
  const col = state.columns.find((c) => c.id === card.column_id);
  if (!col) return;

  // Remove any existing card with the same id (idempotent).
  col.cards = col.cards.filter((c) => c.id !== card.id);
  col.cards.push(card);
  sortCards(col);
}

/**
 * Apply a `card:moved` event.
 * Removes the card from its source column and inserts it into the target.
 * @param {Card}   card
 * @param {string} sourceColumnId
 */
export function applyCardMoved(card, sourceColumnId) {
  // Remove from every column (handles the case where sourceColumnId is stale).
  for (const col of state.columns) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Insert into target column.
  const targetCol = state.columns.find((c) => c.id === card.column_id);
  if (targetCol) {
    targetCol.cards.push(card);
    sortCards(targetCol);
  }
}

/**
 * Apply a `renorm` event – update positions for all listed cards in a column.
 * @param {string}                          columnId
 * @param {Array<{ id: string, position: number }>} cards
 */
export function applyRenorm(columnId, cards) {
  const col = state.columns.find((c) => c.id === columnId);
  if (!col) return;

  const posMap = new Map(cards.map((c) => [c.id, c.position]));
  for (const card of col.cards) {
    if (posMap.has(card.id)) {
      card.position = posMap.get(card.id);
    }
  }
  sortCards(col);
}

/**
 * Sort a column's cards in-place by position ascending.
 * @param {Column} col
 */
function sortCards(col) {
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Find a card by id across all columns.
 * @param {string} id
 * @returns {Card|undefined}
 */
export function findCard(id) {
  for (const col of state.columns) {
    const card = col.cards.find((c) => c.id === id);
    if (card) return card;
  }
}

/**
 * Find the column that currently contains a card.
 * @param {string} cardId
 * @returns {Column|undefined}
 */
export function findColumnForCard(cardId) {
  return state.columns.find((col) => col.cards.some((c) => c.id === cardId));
}
