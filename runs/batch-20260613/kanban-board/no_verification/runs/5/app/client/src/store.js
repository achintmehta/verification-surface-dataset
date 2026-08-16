/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) and provides
 * mutation helpers used by both the optimistic UI and SSE reconciliation.
 *
 * All mutations return the new state; the store itself is a plain object
 * that the UI layer reads directly.
 */

/** @type {{ columns: Map<string, Column>, columnOrder: string[] }} */
const state = {
  /** Map<columnId, { id, title, position, cards: Card[] }> */
  columns: new Map(),
  /** Ordered list of column IDs */
  columnOrder: [],
};

export function getState() {
  return state;
}

/**
 * Replace the entire board state from the server's response.
 * @param {{ columns: Array }} board
 */
export function loadBoard(board) {
  state.columns.clear();
  state.columnOrder = [];

  for (const col of board.columns) {
    state.columns.set(col.id, {
      id: col.id,
      title: col.title,
      position: col.position,
      cards: [...col.cards].sort((a, b) => a.position - b.position),
    });
    state.columnOrder.push(col.id);
  }
}

/**
 * Add or replace a card in the store (used for optimistic creates and SSE reconciliation).
 * @param {object} card
 */
export function upsertCard(card) {
  // Remove the card from any column it currently lives in (handles cross-column moves)
  for (const col of state.columns.values()) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  const col = state.columns.get(card.column_id);
  if (!col) {
    console.warn('[store] upsertCard: unknown column', card.column_id);
    return;
  }

  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Apply a renormalization broadcast: replace all cards in a column.
 * @param {string} columnId
 * @param {object[]} cards
 */
export function applyRenorm(columnId, cards) {
  const col = state.columns.get(columnId);
  if (!col) return;
  col.cards = [...cards].sort((a, b) => a.position - b.position);
}

/**
 * Optimistically move a card within the store before the server confirms.
 * Returns a snapshot of the card's previous state for rollback.
 *
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string|null} afterId   - card above (lower position)
 * @param {string|null} beforeId  - card below (higher position)
 * @returns {{ prevColumnId: string, prevPosition: number } | null}
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find the card
  let card = null;
  let prevColumnId = null;

  for (const col of state.columns.values()) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) {
      card = { ...found };
      prevColumnId = col.id;
      break;
    }
  }

  if (!card) return null;

  const snapshot = { prevColumnId, prevPosition: card.position };

  // Remove from source column
  const srcCol = state.columns.get(prevColumnId);
  if (srcCol) srcCol.cards = srcCol.cards.filter((c) => c.id !== cardId);

  // Compute an optimistic position
  const tgtCol = state.columns.get(targetColumnId);
  if (!tgtCol) return snapshot;

  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const a = tgtCol.cards.find((c) => c.id === afterId);
    if (a) afterPos = a.position;
  }
  if (beforeId) {
    const b = tgtCol.cards.find((c) => c.id === beforeId);
    if (b) beforePos = b.position;
  }

  let optimisticPos;
  if (afterPos === null && beforePos === null) {
    optimisticPos = (tgtCol.cards.length + 1) * 1000;
  } else if (afterPos === null) {
    optimisticPos = beforePos - 500;
  } else if (beforePos === null) {
    optimisticPos = afterPos + 500;
  } else {
    optimisticPos = (afterPos + beforePos) / 2;
  }

  const movedCard = { ...card, column_id: targetColumnId, position: optimisticPos };
  tgtCol.cards.push(movedCard);
  tgtCol.cards.sort((a, b) => a.position - b.position);

  return snapshot;
}
