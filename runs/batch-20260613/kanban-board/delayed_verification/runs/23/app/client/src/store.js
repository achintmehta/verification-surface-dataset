/**
 * Client-side in-memory store of board state.
 * columns: [ { id, title, position, cards: [ { id, column_id, text, position, created_at } ] } ]
 */

let boardState = { columns: [] };
let listeners = [];

export function getState() {
  return boardState;
}

export function setState(newState) {
  boardState = newState;
  notify();
}

export function subscribe(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter(l => l !== fn);
  };
}

function notify() {
  for (const fn of listeners) {
    fn(boardState);
  }
}

// ─── Mutations (used for optimistic + server reconciliation) ───────

function sortByPosition(a, b) {
  return parseFloat(a.position) - parseFloat(b.position);
}

export function addCardToColumn(card) {
  boardState = {
    ...boardState,
    columns: boardState.columns.map(col => {
      if (col.id === card.column_id) {
        // Check if card already exists (idempotent)
        const exists = col.cards.some(c => c.id === card.id);
        if (exists) return col;
        const cards = [...col.cards, card].sort(sortByPosition);
        return { ...col, cards };
      }
      return col;
    }),
  };
  notify();
}

export function removeCardFromAllColumns(cardId) {
  boardState = {
    ...boardState,
    columns: boardState.columns.map(col => ({
      ...col,
      cards: col.cards.filter(c => c.id !== cardId),
    })),
  };
}

export function moveCardInState(card, fromColumnId) {
  // Remove from all columns first (ensures card is in exactly one place)
  boardState = {
    ...boardState,
    columns: boardState.columns.map(col => {
      const filteredCards = col.cards.filter(c => c.id !== card.id);
      if (col.id === card.column_id) {
        // Add card to target column
        const cards = [...filteredCards, card].sort(sortByPosition);
        return { ...col, cards };
      }
      return { ...col, cards: filteredCards };
    }),
  };
  notify();
}

export function replaceColumnCards(columnId, cards) {
  boardState = {
    ...boardState,
    columns: boardState.columns.map(col => {
      if (col.id === columnId) {
        return { ...col, cards: [...cards].sort(sortByPosition) };
      }
      // Also remove any of these card IDs from other columns (safety)
      const cardIds = new Set(cards.map(c => c.id));
      return {
        ...col,
        cards: col.cards.filter(c => !cardIds.has(c.id)),
      };
    }),
  };
  notify();
}

export function deleteCardFromState(cardId) {
  boardState = {
    ...boardState,
    columns: boardState.columns.map(col => ({
      ...col,
      cards: col.cards.filter(c => c.id !== cardId),
    })),
  };
  notify();
}
