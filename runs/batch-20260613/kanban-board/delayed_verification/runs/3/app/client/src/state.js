/**
 * Client-side board state store.
 *
 * Holds the canonical board (columns + cards) and exposes helpers for
 * optimistic mutations and server reconciliation.
 *
 * The store is intentionally simple: it is a plain object that the UI
 * reads directly.  All mutations go through the exported functions so
 * that ordering invariants are maintained.
 */

/** @type {{ columns: Map<string, Column>, columnOrder: string[] }} */
const state = {
  /** Map<columnId, { id, title, position, cards: Card[] }> */
  columns: new Map(),
  /** Ordered list of column ids */
  columnOrder: [],
};

export function getState() {
  return state;
}

/* ------------------------------------------------------------------ */
/*  Initialise from server board response                               */
/* ------------------------------------------------------------------ */
export function initState(boardData) {
  state.columns.clear();
  state.columnOrder = [];

  for (const col of boardData.columns) {
    state.columns.set(col.id, {
      id: col.id,
      title: col.title,
      position: col.position,
      cards: [...col.cards].sort((a, b) => a.position - b.position),
    });
    state.columnOrder.push(col.id);
  }
}

/* ------------------------------------------------------------------ */
/*  Card helpers                                                        */
/* ------------------------------------------------------------------ */

/** Find which column currently holds a card (returns column object or null). */
export function findCardColumn(cardId) {
  for (const col of state.columns.values()) {
    if (col.cards.some((c) => c.id === cardId)) return col;
  }
  return null;
}

/** Find a card by id across all columns. */
export function findCard(cardId) {
  for (const col of state.columns.values()) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

/**
 * Optimistically move a card in local state.
 * Returns the previous column id so the caller can undo if needed.
 *
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string|null} afterId   - card above the slot
 * @param {string|null} beforeId  - card below the slot
 * @returns {string|null} previous column id
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  const srcCol = findCardColumn(cardId);
  if (!srcCol) return null;

  const card = srcCol.cards.find((c) => c.id === cardId);
  if (!card) return null;

  const prevColumnId = srcCol.id;

  // Remove from source
  srcCol.cards = srcCol.cards.filter((c) => c.id !== cardId);

  // Insert into target
  const targetCol = state.columns.get(targetColumnId);
  if (!targetCol) return prevColumnId;

  const insertIdx = computeInsertIndex(targetCol.cards, afterId, beforeId);
  targetCol.cards.splice(insertIdx, 0, { ...card, column_id: targetColumnId });

  return prevColumnId;
}

/**
 * Apply the server's canonical card state (after a move or create).
 * Ensures the card exists in exactly one column at the correct position.
 *
 * @param {object} card - canonical card from server
 * @returns {boolean} true if the position changed from the optimistic guess
 */
export function reconcileCard(card) {
  // Remove the card from wherever it currently lives
  let optimisticIndex = -1;
  let optimisticColumnId = null;

  for (const col of state.columns.values()) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      optimisticIndex = idx;
      optimisticColumnId = col.id;
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Insert into the canonical column at the canonical position
  const targetCol = state.columns.get(card.column_id);
  if (!targetCol) return false;

  const canonicalCard = { ...card, position: parseFloat(card.position) };
  const insertIdx = findSortedIndex(targetCol.cards, canonicalCard.position);
  targetCol.cards.splice(insertIdx, 0, canonicalCard);

  // Determine whether the position changed
  const positionChanged =
    optimisticColumnId !== card.column_id || optimisticIndex !== insertIdx;

  return positionChanged;
}

/**
 * Apply a full column reorder (after server renormalisation).
 * @param {string} columnId
 * @param {object[]} cards - canonical ordered card list
 */
export function applyColumnReorder(columnId, cards) {
  const col = state.columns.get(columnId);
  if (!col) return;
  col.cards = cards.map((c) => ({ ...c, position: parseFloat(c.position) }));
}

/**
 * Add a brand-new card (from a `card:created` SSE event).
 * If the card already exists (e.g. the creating client already has it
 * from the HTTP response), update it in place.
 *
 * @param {object} card
 */
export function upsertCard(card) {
  // Remove any existing copy
  for (const col of state.columns.values()) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  const targetCol = state.columns.get(card.column_id);
  if (!targetCol) return;

  const canonicalCard = { ...card, position: parseFloat(card.position) };
  const insertIdx = findSortedIndex(targetCol.cards, canonicalCard.position);
  targetCol.cards.splice(insertIdx, 0, canonicalCard);
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Compute the index at which to insert a card given afterId / beforeId hints.
 * Falls back to appending at the end.
 */
function computeInsertIndex(cards, afterId, beforeId) {
  if (afterId) {
    const idx = cards.findIndex((c) => c.id === afterId);
    if (idx !== -1) return idx + 1;
  }
  if (beforeId) {
    const idx = cards.findIndex((c) => c.id === beforeId);
    if (idx !== -1) return idx;
  }
  return cards.length;
}

/**
 * Binary-search for the insertion index that keeps `cards` sorted by position.
 */
function findSortedIndex(cards, position) {
  let lo = 0;
  let hi = cards.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cards[mid].position <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
