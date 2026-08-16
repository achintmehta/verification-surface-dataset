/**
 * Client-side board state store.
 *
 * Holds the canonical board state as received from the server and provides
 * helpers for optimistic mutations and reconciliation.
 *
 * Data shape:
 *   state.columns  – Map<columnId, { id, title, position, cards: Card[] }>
 *                    cards are kept sorted by position at all times.
 *
 * All mutations return the new state (the same Map, mutated in place) so
 * callers can trigger a re-render.
 */

/** @type {Map<string, { id: string, title: string, position: number, cards: object[] }>} */
export const columns = new Map();

// ---------------------------------------------------------------------------
// Initialise / replace entire board state
// ---------------------------------------------------------------------------

/**
 * Replace the entire board state from a server payload.
 * @param {Array} serverColumns
 */
export function initBoard(serverColumns) {
  columns.clear();
  for (const col of serverColumns) {
    columns.set(col.id, {
      ...col,
      cards: [...col.cards].sort((a, b) => a.position - b.position),
    });
  }
}

// ---------------------------------------------------------------------------
// Card helpers
// ---------------------------------------------------------------------------

/**
 * Find which column currently holds a card.
 * @param {string} cardId
 * @returns {{ col: object, index: number } | null}
 */
export function findCard(cardId) {
  for (const col of columns.values()) {
    const index = col.cards.findIndex((c) => c.id === cardId);
    if (index !== -1) return { col, index };
  }
  return null;
}

/**
 * Upsert a card from a server event (card:created or card:moved).
 * Removes the card from any other column it may currently occupy (prevents
 * duplication) then inserts/updates it in the correct column.
 * @param {object} card – canonical card from server
 */
export function upsertCard(card) {
  // Remove from any existing location.
  for (const col of columns.values()) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Insert into the target column.
  const col = columns.get(card.column_id);
  if (!col) return; // Unknown column – ignore.

  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Replace all cards in a column (used after server renormalisation).
 * @param {string} columnId
 * @param {object[]} cards
 */
export function replaceColumnCards(columnId, cards) {
  const col = columns.get(columnId);
  if (!col) return;
  col.cards = [...cards].sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// Optimistic move
// ---------------------------------------------------------------------------

/**
 * Optimistically move a card within the local state.
 * Returns a snapshot { cardId, fromColumnId, fromIndex, toColumnId, toIndex }
 * that can be used to roll back if the server rejects the move.
 *
 * @param {string} cardId
 * @param {string} toColumnId
 * @param {number} toIndex      – desired index in the target column's card array
 * @returns {{ cardId, fromColumnId, fromIndex, toColumnId, toIndex, card } | null}
 */
export function optimisticMove(cardId, toColumnId, toIndex) {
  const found = findCard(cardId);
  if (!found) return null;

  const { col: fromCol, index: fromIndex } = found;
  const toCol = columns.get(toColumnId);
  if (!toCol) return null;

  // Snapshot for rollback.
  const snapshot = {
    cardId,
    fromColumnId: fromCol.id,
    fromIndex,
    toColumnId,
    toIndex,
    card: { ...fromCol.cards[fromIndex] },
  };

  // Remove from source.
  const [card] = fromCol.cards.splice(fromIndex, 1);

  // Compute a synthetic position so the card sorts correctly.
  // We'll use the server's canonical position once the response arrives.
  const targetCards = toCol.cards;
  const prevCard = toIndex > 0 ? targetCards[toIndex - 1] : null;
  const nextCard = toIndex < targetCards.length ? targetCards[toIndex] : null;

  let syntheticPos;
  if (prevCard && nextCard) {
    syntheticPos = (prevCard.position + nextCard.position) / 2;
  } else if (prevCard) {
    syntheticPos = prevCard.position + 500;
  } else if (nextCard) {
    syntheticPos = nextCard.position / 2;
  } else {
    syntheticPos = 1000;
  }

  card.position = syntheticPos;
  card.column_id = toColumnId;

  // Insert at the computed position.
  toCol.cards.push(card);
  toCol.cards.sort((a, b) => a.position - b.position);

  return snapshot;
}

/**
 * Roll back an optimistic move using a snapshot.
 * @param {object} snapshot – returned by optimisticMove
 */
export function rollbackMove(snapshot) {
  if (!snapshot) return;
  const { card, fromColumnId, toColumnId } = snapshot;

  // Remove from wherever it ended up.
  const toCol = columns.get(toColumnId);
  if (toCol) {
    const idx = toCol.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) toCol.cards.splice(idx, 1);
  }

  // Restore to original column.
  const fromCol = columns.get(fromColumnId);
  if (fromCol) {
    fromCol.cards.push(snapshot.card);
    fromCol.cards.sort((a, b) => a.position - b.position);
  }
}
