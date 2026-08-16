/**
 * Client-side board state.
 *
 * The state is a plain object:
 *   {
 *     columns: [
 *       { id, title, position, cards: [{ id, column_id, text, position, created_at }, ...] },
 *       ...
 *     ]
 *   }
 *
 * Cards within each column are always kept sorted by position ascending.
 */

let _state = { columns: [] };

export function getState() {
  return _state;
}

export function setState(newState) {
  _state = newState;
  // Ensure cards are sorted within each column
  for (const col of _state.columns) {
    col.cards.sort((a, b) => a.position - b.position);
  }
}

/** Find a column by id. */
export function findColumn(columnId) {
  return _state.columns.find(c => c.id === columnId) ?? null;
}

/** Find a card by id across all columns. Returns { card, column } or null. */
export function findCard(cardId) {
  for (const col of _state.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/**
 * Apply a card:created event.
 * Adds the card to the correct column (or ignores if column unknown).
 */
export function applyCardCreated(card) {
  const col = findColumn(card.column_id);
  if (!col) return;
  // Avoid duplicates (e.g. if we created it optimistically)
  if (!col.cards.find(c => c.id === card.id)) {
    col.cards.push(card);
  } else {
    // Update in place (reconcile)
    const idx = col.cards.findIndex(c => c.id === card.id);
    col.cards[idx] = card;
  }
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Apply a card:moved event.
 * Removes the card from its current column and places it in the target column.
 */
export function applyCardMoved(card) {
  // Remove from wherever it currently lives
  for (const col of _state.columns) {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }
  // Insert into target column
  const targetCol = findColumn(card.column_id);
  if (!targetCol) return;
  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);
}

/**
 * Apply a column:reordered event (after renormalisation).
 * @param {string} columnId
 * @param {Array<{id:string, position:number}>} cards - updated positions
 */
export function applyColumnReordered(columnId, cards) {
  const col = findColumn(columnId);
  if (!col) return;
  for (const update of cards) {
    const card = col.cards.find(c => c.id === update.id);
    if (card) card.position = update.position;
  }
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Optimistically move a card in local state.
 * Returns the previous state snapshot for rollback.
 */
export function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  // Snapshot for rollback
  const snapshot = JSON.parse(JSON.stringify(_state));

  const found = findCard(cardId);
  if (!found) return snapshot;

  const { card, column: srcCol } = found;
  const targetCol = findColumn(targetColumnId);
  if (!targetCol) return snapshot;

  // Remove from source
  srcCol.cards = srcCol.cards.filter(c => c.id !== cardId);

  // Compute optimistic position
  const beforeCard = beforeId ? targetCol.cards.find(c => c.id === beforeId) : null;
  const afterCard  = afterId  ? targetCol.cards.find(c => c.id === afterId)  : null;

  let newPos;
  if (beforeCard && afterCard) {
    newPos = (beforeCard.position + afterCard.position) / 2;
  } else if (beforeCard) {
    newPos = beforeCard.position + 1000;
  } else if (afterCard) {
    newPos = afterCard.position - 1000;
  } else {
    // Empty column or end
    const maxPos = targetCol.cards.reduce((m, c) => Math.max(m, c.position), 0);
    newPos = maxPos + 1000;
  }

  card.column_id = targetColumnId;
  card.position  = newPos;
  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);

  return snapshot;
}

export function rollbackState(snapshot) {
  _state = snapshot;
}
