/**
 * Client-side board state.
 *
 * Columns are stored in an ordered array.
 * Cards are stored in a flat Map keyed by card id for O(1) lookup.
 * Each column object has a `cards` array (ordered by position).
 */

/** @type {Array<{id:string, title:string, position:number, cards:Array}>} */
let columns = [];

/** @type {Map<string, object>} cardId → card */
const cardMap = new Map();

/* ── Initialise from server snapshot ─────────────────────── */
export function initState(boardData) {
  columns = boardData.map(col => ({
    ...col,
    cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
  }));
  cardMap.clear();
  for (const col of columns) {
    for (const card of col.cards) cardMap.set(card.id, card);
  }
}

/* ── Getters ──────────────────────────────────────────────── */
export function getColumns() { return columns; }

export function getCard(id) { return cardMap.get(id) ?? null; }

export function getColumnById(id) {
  return columns.find(c => c.id === id) ?? null;
}

/* ── Mutations ────────────────────────────────────────────── */

/**
 * Upsert a card into the state (used for both create and move events).
 * Removes the card from its previous column if it moved.
 */
export function upsertCard(card) {
  const existing = cardMap.get(card.id);

  // Remove from old column if it changed
  if (existing && existing.column_id !== card.column_id) {
    const oldCol = getColumnById(existing.column_id);
    if (oldCol) {
      oldCol.cards = oldCol.cards.filter(c => c.id !== card.id);
    }
  }

  // Update or insert in new column
  const col = getColumnById(card.column_id);
  if (col) {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx >= 0) {
      col.cards[idx] = card;
    } else {
      col.cards.push(card);
    }
    col.cards.sort((a, b) => a.position - b.position);
  }

  cardMap.set(card.id, card);
}

/**
 * Replace all cards in a column (used after renormalisation broadcast).
 */
export function replaceColumnCards(columnId, cards) {
  const col = getColumnById(columnId);
  if (!col) return;

  // Remove old cards from map
  for (const c of col.cards) cardMap.delete(c.id);

  col.cards = [...cards].sort((a, b) => a.position - b.position);
  for (const c of col.cards) cardMap.set(c.id, c);
}

/**
 * Optimistically move a card in local state (before server confirms).
 * Returns a snapshot so we can roll back if needed.
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  const card = cardMap.get(cardId);
  if (!card) return null;

  // Snapshot for rollback
  const snapshot = {
    card: { ...card },
    sourceColumnCards: [...(getColumnById(card.column_id)?.cards ?? [])].map(c => ({ ...c })),
    targetColumnCards: [...(getColumnById(targetColumnId)?.cards ?? [])].map(c => ({ ...c })),
  };

  // Compute a local optimistic position
  const targetCol = getColumnById(targetColumnId);
  if (!targetCol) return snapshot;

  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const a = cardMap.get(afterId);
    if (a) afterPos = a.position;
  }
  if (beforeId) {
    const b = cardMap.get(beforeId);
    if (b) beforePos = b.position;
  }

  let optimisticPos;
  if (afterPos === null && beforePos === null) {
    optimisticPos = 1000;
  } else if (afterPos === null) {
    optimisticPos = beforePos / 2;
  } else if (beforePos === null) {
    optimisticPos = afterPos + 1000;
  } else {
    optimisticPos = (afterPos + beforePos) / 2;
  }

  const updatedCard = { ...card, column_id: targetColumnId, position: optimisticPos };
  upsertCard(updatedCard);

  return snapshot;
}
