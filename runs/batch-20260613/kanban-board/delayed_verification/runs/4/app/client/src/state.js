/**
 * Client-side board state store.
 *
 * Holds the canonical board state as received from the server and provides
 * helpers for optimistic mutations and reconciliation.
 *
 * Shape:
 *   columns: Map<columnId, { id, title, position, cards: Card[] }>
 *   cards:   Map<cardId,   Card>
 *
 * where Card = { id, column_id, text, position, created_at }
 *
 * Cards within each column are always kept sorted by `position` ascending.
 */

/** @type {Map<string, {id:string, title:string, position:number, cards:object[]}>} */
export const columns = new Map();

/** @type {Map<string, object>} */
export const cards = new Map();

/* ── Initialise from server board response ─────────────────────────────── */

/**
 * Replace the entire board state with the server's authoritative snapshot.
 * @param {{ columns: Array }} board
 */
export function initBoard(board) {
  columns.clear();
  cards.clear();

  for (const col of board.columns) {
    const sortedCards = [...col.cards].sort((a, b) => a.position - b.position);
    columns.set(col.id, { id: col.id, title: col.title, position: col.position, cards: sortedCards });
    for (const card of sortedCards) cards.set(card.id, card);
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

/** Return a column's card array, sorted by position. */
export function getColumnCards(columnId) {
  return columns.get(columnId)?.cards ?? [];
}

/** Insert or update a card in the state, maintaining sort order. */
export function upsertCard(card) {
  const existing = cards.get(card.id);

  // Remove from old column if it moved
  if (existing && existing.column_id !== card.column_id) {
    const oldCol = columns.get(existing.column_id);
    if (oldCol) {
      oldCol.cards = oldCol.cards.filter(c => c.id !== card.id);
    }
  }

  cards.set(card.id, card);

  const col = columns.get(card.column_id);
  if (!col) return;

  // Remove stale entry (same id) then re-insert
  col.cards = col.cards.filter(c => c.id !== card.id);
  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Replace all cards in a column with the server's authoritative list.
 * Used after a renormalization broadcast.
 *
 * @param {string}   columnId
 * @param {object[]} serverCards
 */
export function replaceColumnCards(columnId, serverCards) {
  const col = columns.get(columnId);
  if (!col) return;

  // Remove old card entries for this column from the global map
  for (const c of col.cards) cards.delete(c.id);

  const sorted = [...serverCards].sort((a, b) => a.position - b.position);
  col.cards = sorted;
  for (const c of sorted) cards.set(c.id, c);
}

/**
 * Optimistically move a card in local state (before server confirms).
 * Returns a snapshot of the previous state for rollback.
 *
 * @param {string}      cardId
 * @param {string}      targetColumnId
 * @param {string|null} afterId   - card that should be above
 * @param {string|null} beforeId  - card that should be below
 * @returns {{ prevColumnId: string, prevPosition: number }}
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  const card = cards.get(cardId);
  if (!card) return null;

  const snapshot = { prevColumnId: card.column_id, prevPosition: card.position };

  // Compute a local optimistic position
  const targetCards = getColumnCards(targetColumnId).filter(c => c.id !== cardId);
  const afterCard  = afterId  ? cards.get(afterId)  : null;
  const beforeCard = beforeId ? cards.get(beforeId) : null;

  let optPos;
  if (!afterCard && !beforeCard) {
    optPos = 1000;
  } else if (!afterCard) {
    optPos = beforeCard.position - 1;
  } else if (!beforeCard) {
    optPos = afterCard.position + 1;
  } else {
    optPos = (afterCard.position + beforeCard.position) / 2;
  }

  upsertCard({ ...card, column_id: targetColumnId, position: optPos });
  return snapshot;
}

/**
 * Roll back an optimistic move using a previously captured snapshot.
 */
export function rollbackMove(cardId, snapshot) {
  if (!snapshot) return;
  const card = cards.get(cardId);
  if (!card) return;
  upsertCard({ ...card, column_id: snapshot.prevColumnId, position: snapshot.prevPosition });
}
