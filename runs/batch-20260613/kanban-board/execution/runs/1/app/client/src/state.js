/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) and provides
 * mutation helpers used by both the optimistic UI and SSE reconciliation.
 *
 * State shape:
 *   {
 *     columns: [
 *       { id, title, position, cards: [{ id, column_id, text, position, created_at }] }
 *     ]
 *   }
 *
 * Cards within each column are always kept sorted by `position` ascending.
 */

/** @type {{ columns: Array }} */
let state = { columns: [] };

/** Registered change listeners */
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

/* ── Getters ─────────────────────────────────────────────── */

export function getState() {
  return state;
}

export function getColumn(columnId) {
  return state.columns.find((c) => c.id === columnId) ?? null;
}

export function getCard(cardId) {
  for (const col of state.columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/* ── Mutations ───────────────────────────────────────────── */

/**
 * Replace the entire board state (used on initial load and full reconcile).
 */
export function setBoard(columns) {
  state = {
    columns: columns.map((col) => ({
      ...col,
      cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
    })),
  };
  notify();
}

/**
 * Insert or update a card in the correct column, removing it from any
 * other column it may currently occupy (ensures no duplication).
 */
export function upsertCard(card) {
  // Remove from any existing location
  for (const col of state.columns) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Insert into target column
  const targetCol = state.columns.find((c) => c.id === card.column_id);
  if (!targetCol) {
    console.warn(`[state] upsertCard: column ${card.column_id} not found`);
    return;
  }

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);

  notify();
}

/**
 * Replace all cards in a column (used after server renormalization).
 */
export function setColumnCards(columnId, cards) {
  const col = state.columns.find((c) => c.id === columnId);
  if (!col) return;
  col.cards = [...cards].sort((a, b) => a.position - b.position);
  notify();
}

/**
 * Optimistically move a card to a new position within the state.
 * Returns the previous card data so it can be restored on failure.
 *
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string|null} afterId   - card that will come before the moved card
 * @param {string|null} beforeId  - card that will come after the moved card
 * @returns {{ prevCard: object, prevColumnId: string } | null}
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  const found = getCard(cardId);
  if (!found) return null;

  const { card: prevCard, column: prevColumn } = found;
  const prevColumnId = prevColumn.id;

  // Compute an optimistic position
  const targetCol = getColumn(targetColumnId);
  if (!targetCol) return null;

  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const afterCard = targetCol.cards.find((c) => c.id === afterId);
    if (afterCard) afterPos = afterCard.position;
  }
  if (beforeId) {
    const beforeCard = targetCol.cards.find((c) => c.id === beforeId);
    if (beforeCard) beforePos = beforeCard.position;
  }

  let optimisticPosition;
  if (afterPos !== null && beforePos !== null) {
    optimisticPosition = (afterPos + beforePos) / 2;
  } else if (afterPos !== null) {
    optimisticPosition = afterPos + 1;
  } else if (beforePos !== null) {
    optimisticPosition = beforePos - 1;
  } else {
    // Append to end
    const maxPos = targetCol.cards.reduce((m, c) => Math.max(m, c.position), 0);
    optimisticPosition = maxPos + 1000;
  }

  const optimisticCard = {
    ...prevCard,
    column_id: targetColumnId,
    position: optimisticPosition,
  };

  upsertCard(optimisticCard);

  return { prevCard, prevColumnId };
}

/**
 * Restore a card to its previous state (used when a move request fails).
 */
export function rollbackCard(prevCard) {
  upsertCard(prevCard);
}
