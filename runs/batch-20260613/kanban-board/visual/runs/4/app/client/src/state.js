/**
 * Client-side board state.
 *
 * The state is a Map<columnId, { id, title, position, cards: Card[] }>
 * where cards are always kept sorted by position.
 *
 * All mutations return a new state object (shallow-immutable) so the
 * renderer can diff cheaply.
 */

export function createState() {
  return {
    columns: [],   // ordered array of column objects
    cards: {},     // Map<columnId, Card[]>  – each array sorted by position
  };
}

export function applyBoard(state, { columns }) {
  const newCards = {};
  const newColumns = columns.map(col => {
    newCards[col.id] = [...(col.cards || [])].sort((a, b) => a.position - b.position);
    return { id: col.id, title: col.title, position: col.position };
  });
  newColumns.sort((a, b) => a.position - b.position);
  return { columns: newColumns, cards: newCards };
}

export function applyCardCreated(state, { card }) {
  const colCards = [...(state.cards[card.column_id] || [])];
  // Avoid duplicates (idempotent)
  if (!colCards.find(c => c.id === card.id)) {
    colCards.push(card);
    colCards.sort((a, b) => a.position - b.position);
  }
  return {
    ...state,
    cards: { ...state.cards, [card.column_id]: colCards },
  };
}

export function applyCardMoved(state, { card }) {
  // Remove card from every column (handles cross-column moves)
  const newCards = {};
  for (const [colId, cards] of Object.entries(state.cards)) {
    newCards[colId] = cards.filter(c => c.id !== card.id);
  }
  // Insert into target column
  const target = [...(newCards[card.column_id] || [])];
  target.push(card);
  target.sort((a, b) => a.position - b.position);
  newCards[card.column_id] = target;
  return { ...state, cards: newCards };
}

export function applyColumnReordered(state, { columnId, cards }) {
  const sorted = [...cards].sort((a, b) => a.position - b.position);
  return {
    ...state,
    cards: { ...state.cards, [columnId]: sorted },
  };
}

/**
 * Optimistically move a card in local state (before server confirms).
 * Returns the new state.
 */
export function optimisticMove(state, cardId, targetColumnId, afterId, beforeId) {
  // Find the card
  let card = null;
  for (const cards of Object.values(state.cards)) {
    card = cards.find(c => c.id === cardId);
    if (card) break;
  }
  if (!card) return state;

  // Compute an optimistic position
  let afterPos = null;
  let beforePos = null;
  const targetCards = state.cards[targetColumnId] || [];

  if (afterId) {
    const a = targetCards.find(c => c.id === afterId);
    if (a) afterPos = a.position;
  }
  if (beforeId) {
    const b = targetCards.find(c => c.id === beforeId);
    if (b) beforePos = b.position;
  }

  let position;
  if (afterPos === null && beforePos === null) {
    const maxPos = targetCards.reduce((m, c) => Math.max(m, c.position), 0);
    position = maxPos + 1000;
  } else if (afterPos === null) {
    position = beforePos / 2;
  } else if (beforePos === null) {
    position = afterPos + 1000;
  } else {
    position = (afterPos + beforePos) / 2;
  }

  const movedCard = { ...card, column_id: targetColumnId, position };
  return applyCardMoved(state, { card: movedCard });
}
