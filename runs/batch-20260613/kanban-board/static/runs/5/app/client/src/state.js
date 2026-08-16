/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) and exposes mutation
 * helpers used by both the optimistic drag-and-drop path and the SSE
 * reconciliation path.
 *
 * The store is intentionally simple: it is a plain object that is mutated
 * in-place.  The UI layer (board.js) is responsible for re-rendering after
 * each mutation.
 */

/** @type {{ columns: Column[] }} */
export const state = {
  columns: [],
};

// ---------------------------------------------------------------------------
// Types (JSDoc only – no runtime overhead)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 * @typedef {{ id: string, title: string, position: number, cards: Card[] }} Column
 */

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

/**
 * Replace the entire board state with the data returned by GET /api/board.
 * @param {{ columns: Column[] }} board
 */
export function initState(board) {
  state.columns = board.columns.map((col) => ({
    ...col,
    cards: [...col.cards].sort((a, b) => a.position - b.position),
  }));
}

// ---------------------------------------------------------------------------
// Card helpers
// ---------------------------------------------------------------------------

/** Find a card by id across all columns.  Returns { card, column } or null. */
export function findCard(cardId) {
  for (const col of state.columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/** Find a column by id. */
export function findColumn(columnId) {
  return state.columns.find((c) => c.id === columnId) ?? null;
}

/**
 * Apply a card:created event.
 * Adds the card to the correct column (deduplicating if it already exists).
 * @param {Card} card
 */
export function applyCardCreated(card) {
  // Remove any stale copy (shouldn't happen, but be safe).
  removeCardFromState(card.id);

  const col = findColumn(card.column_id);
  if (!col) return; // unknown column – ignore

  col.cards.push(card);
  sortColumn(col);
}

/**
 * Apply a card:moved event.
 * Moves the card to its new column and position, replacing any optimistic copy.
 * @param {Card} card
 */
export function applyCardMoved(card) {
  // Remove from wherever it currently lives.
  removeCardFromState(card.id);

  const col = findColumn(card.column_id);
  if (!col) return;

  col.cards.push(card);
  sortColumn(col);
}

/**
 * Apply a column:renormed event.
 * Replaces all cards in the column with the server's canonical ordered list.
 * @param {string}  columnId
 * @param {Card[]}  cards
 */
export function applyColumnRenormed(columnId, cards) {
  const col = findColumn(columnId);
  if (!col) return;

  col.cards = [...cards].sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// Optimistic helpers (used by drag-and-drop before the server responds)
// ---------------------------------------------------------------------------

/**
 * Optimistically move a card within the state so the UI can re-render
 * immediately.  The server's canonical response will reconcile any difference.
 *
 * @param {string}      cardId
 * @param {string}      targetColumnId
 * @param {string|null} beforeId  – card that will be immediately before
 * @param {string|null} afterId   – card that will be immediately after
 */
export function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return;

  const { card } = found;

  // Remove from current column.
  removeCardFromState(cardId);

  const targetCol = findColumn(targetColumnId);
  if (!targetCol) return;

  // Compute an optimistic position.
  const beforeCard = beforeId
    ? targetCol.cards.find((c) => c.id === beforeId)
    : null;
  const afterCard = afterId
    ? targetCol.cards.find((c) => c.id === afterId)
    : null;

  const beforePos = beforeCard ? beforeCard.position : null;
  const afterPos = afterCard ? afterCard.position : null;

  let position;
  if (beforePos == null && afterPos == null) {
    position = 1000;
  } else if (afterPos == null) {
    position = beforePos + 1000;
  } else if (beforePos == null) {
    position = afterPos / 2;
  } else {
    position = (beforePos + afterPos) / 2;
  }

  targetCol.cards.push({ ...card, column_id: targetColumnId, position });
  sortColumn(targetCol);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function removeCardFromState(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

function sortColumn(col) {
  col.cards.sort((a, b) => a.position - b.position);
}
