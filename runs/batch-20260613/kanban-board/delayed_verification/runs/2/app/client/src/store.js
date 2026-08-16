/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) and exposes
 * mutation helpers used by both the optimistic drag-and-drop path
 * and the SSE reconciliation path.
 *
 * The store is intentionally framework-free: it just manages plain
 * JS objects and notifies a single registered listener (the renderer).
 */

/** @type {{ columns: Map<string, Column>, columnOrder: string[] }} */
const state = {
  /** id → column object (includes a `cards` array sorted by position) */
  columns: new Map(),
  /** ordered list of column ids */
  columnOrder: [],
};

/** @type {(() => void) | null} */
let changeListener = null;

/**
 * Register a callback that fires whenever state changes.
 * @param {() => void} fn
 */
export function onChange(fn) {
  changeListener = fn;
}

function notify() {
  if (changeListener) changeListener();
}

/* ── Initialisation ──────────────────────────────────────────────────────── */

/**
 * Replace the entire board state from the server's /api/board response.
 * @param {{ columns: Array }} boardData
 */
export function initState(boardData) {
  state.columns.clear();
  state.columnOrder = [];

  for (const col of boardData.columns) {
    state.columnOrder.push(col.id);
    state.columns.set(col.id, {
      id: col.id,
      title: col.title,
      position: col.position,
      cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
    });
  }

  notify();
}

/* ── Read helpers ────────────────────────────────────────────────────────── */

/** Return a shallow copy of the ordered columns array (each column has a `cards` array). */
export function getColumns() {
  return state.columnOrder.map((id) => state.columns.get(id));
}

/** Find a card by id across all columns. Returns { card, column } or null. */
export function findCard(cardId) {
  for (const col of state.columns.values()) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/**
 * Upsert a card into the store (used for both create and move).
 * Removes the card from any other column it may currently occupy,
 * then inserts/updates it in the target column and re-sorts.
 *
 * @param {object} card - canonical card from the server
 */
export function upsertCard(card) {
  // Remove from any existing column (handles cross-column moves)
  for (const col of state.columns.values()) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Insert into target column
  const targetCol = state.columns.get(card.column_id);
  if (!targetCol) {
    console.warn('upsertCard: unknown column', card.column_id);
    return;
  }

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);

  notify();
}

/**
 * Replace all cards in a column (used after a renormalization broadcast).
 * @param {string}   columnId
 * @param {object[]} cards
 */
export function replaceColumnCards(columnId, cards) {
  const col = state.columns.get(columnId);
  if (!col) return;
  col.cards = [...cards].sort((a, b) => a.position - b.position);
  notify();
}

/**
 * Optimistically move a card within the local state before the server
 * confirms. Accepts the same card object shape but with a synthetic
 * position derived from the drag-and-drop gesture.
 *
 * @param {string}      cardId
 * @param {string}      targetColumnId
 * @param {string|null} afterId   - card id above the drop slot (null = top)
 * @param {string|null} beforeId  - card id below the drop slot (null = bottom)
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  const found = findCard(cardId);
  if (!found) return;

  const { card } = found;
  const targetCol = state.columns.get(targetColumnId);
  if (!targetCol) return;

  // Compute a synthetic position between afterId and beforeId
  const cards = targetCol.cards.filter((c) => c.id !== cardId);
  const afterCard  = afterId  ? cards.find((c) => c.id === afterId)  : null;
  const beforeCard = beforeId ? cards.find((c) => c.id === beforeId) : null;

  let syntheticPos;
  if (afterCard && beforeCard) {
    syntheticPos = (afterCard.position + beforeCard.position) / 2;
  } else if (afterCard) {
    syntheticPos = afterCard.position + 0.5;
  } else if (beforeCard) {
    syntheticPos = beforeCard.position - 0.5;
  } else {
    syntheticPos = 1; // only card in column
  }

  // Remove from source column
  for (const col of state.columns.values()) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) { col.cards.splice(idx, 1); break; }
  }

  // Insert into target column with synthetic position
  const updatedCard = { ...card, column_id: targetColumnId, position: syntheticPos };
  targetCol.cards.push(updatedCard);
  targetCol.cards.sort((a, b) => a.position - b.position);

  notify();
}
