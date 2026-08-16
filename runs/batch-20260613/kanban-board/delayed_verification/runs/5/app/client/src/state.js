/**
 * state.js – In-memory board state and mutation helpers.
 *
 * The state is a plain object:
 *   {
 *     columns: [
 *       { id, title, position, cards: [{ id, column_id, text, position, created_at }, …] },
 *       …
 *     ]
 *   }
 *
 * Cards within each column are always kept sorted by `position`.
 * All mutations return the new state (same reference, mutated in place) so
 * callers can trigger a re-render.
 */

/** @type {{ columns: Array }} */
export const state = { columns: [] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortCards(cards) {
  cards.sort((a, b) => a.position - b.position);
}

function findColumn(columnId) {
  return state.columns.find(c => c.id === columnId) ?? null;
}

function findCard(cardId) {
  for (const col of state.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace the entire board state (used on initial load).
 * @param {{ columns: Array }} board
 */
export function setBoard(board) {
  state.columns = board.columns.map(col => ({
    ...col,
    cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
  }));
  state.columns.sort((a, b) => a.position - b.position);
}

/**
 * Add or update a card in the appropriate column.
 * If the card already exists in a different column it is removed from there
 * first, guaranteeing it appears in exactly one column.
 *
 * @param {object} card  – canonical card from the server
 */
export function upsertCard(card) {
  // Remove from any existing column (handles cross-column moves).
  for (const col of state.columns) {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Insert into the target column.
  const col = findColumn(card.column_id);
  if (!col) return; // unknown column – ignore

  col.cards.push(card);
  sortCards(col.cards);
}

/**
 * Apply a full column reorder (used after server renormalisation).
 * Replaces the cards array for each affected column with the canonical list.
 *
 * @param {Array<{ columnId: string, cards: Array }>} columns
 */
export function applyReorder(columns) {
  for (const { columnId, cards } of columns) {
    const col = findColumn(columnId);
    if (!col) continue;
    col.cards = [...cards].sort((a, b) => a.position - b.position);
  }
}

/**
 * Optimistically move a card in local state before the server confirms.
 * Returns the previous { columnId, position } so the caller can roll back.
 *
 * @param {string}      cardId
 * @param {string}      targetColumnId
 * @param {string|null} beforeId   card that will be immediately before
 * @param {string|null} afterId    card that will be immediately after
 * @returns {{ prevColumnId: string, prevPosition: number }|null}
 */
export function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return null;

  const { card, column: srcCol } = found;
  const prevColumnId = srcCol.id;
  const prevPosition = card.position;

  // Remove from source column.
  srcCol.cards = srcCol.cards.filter(c => c.id !== cardId);

  // Compute an optimistic position.
  const targetCol = findColumn(targetColumnId);
  if (!targetCol) return null;

  let newPosition;
  const beforeCard = beforeId ? targetCol.cards.find(c => c.id === beforeId) : null;
  const afterCard  = afterId  ? targetCol.cards.find(c => c.id === afterId)  : null;

  const lo = beforeCard?.position ?? 0;
  const hi = afterCard?.position  ?? (lo + 2000);
  newPosition = (lo + hi) / 2;

  // Update card and insert into target column.
  card.column_id = targetColumnId;
  card.position  = newPosition;
  targetCol.cards.push(card);
  sortCards(targetCol.cards);

  return { prevColumnId, prevPosition };
}

/**
 * Roll back an optimistic move (called when the server request fails).
 *
 * @param {string} cardId
 * @param {string} prevColumnId
 * @param {number} prevPosition
 */
export function rollbackMove(cardId, prevColumnId, prevPosition) {
  // Remove from wherever it ended up.
  for (const col of state.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  const col = findColumn(prevColumnId);
  if (!col) return;

  const card = col.cards.find(c => c.id === cardId);
  if (card) {
    card.column_id = prevColumnId;
    card.position  = prevPosition;
  } else {
    // Card was removed; we need to reconstruct a minimal stub.
    // In practice this shouldn't happen but guard anyway.
    col.cards.push({ id: cardId, column_id: prevColumnId, position: prevPosition, text: '' });
  }
  sortCards(col.cards);
}
