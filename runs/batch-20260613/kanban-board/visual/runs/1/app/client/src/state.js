/**
 * Client-side board state.
 * Columns are ordered by `position`.
 * Each column has a `cards` array ordered by `position`.
 */

let _columns = []; // Array<{ id, title, position, cards: Card[] }>

export function getColumns() {
  return _columns;
}

export function setBoard(columns) {
  _columns = columns.map((col) => ({
    ...col,
    cards: [...(col.cards || [])].sort((a, b) => a.position - b.position),
  }));
  _columns.sort((a, b) => a.position - b.position);
}

export function getColumn(columnId) {
  return _columns.find((c) => c.id === columnId) || null;
}

/** Insert or update a card in the correct column, removing it from any other. */
export function upsertCard(card) {
  // Remove from wherever it currently lives
  for (const col of _columns) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }
  // Insert into target column
  const col = getColumn(card.column_id);
  if (!col) return;
  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/** Replace all cards in a column (used after renormalization). */
export function replaceColumnCards(columnId, cards) {
  const col = getColumn(columnId);
  if (!col) return;
  col.cards = [...cards].sort((a, b) => a.position - b.position);
}

/**
 * Optimistically move a card within the local state.
 * Returns the card's previous state so we can roll back.
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find the card
  let card = null;
  for (const col of _columns) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) { card = { ...found }; break; }
  }
  if (!card) return null;

  const snapshot = { ...card };

  // Compute a local optimistic position
  const targetCol = getColumn(targetColumnId);
  if (!targetCol) return null;

  let afterPos = null;
  let beforePos = null;
  if (afterId) {
    const a = targetCol.cards.find((c) => c.id === afterId);
    if (a) afterPos = a.position;
  }
  if (beforeId) {
    const b = targetCol.cards.find((c) => c.id === beforeId);
    if (b) beforePos = b.position;
  }

  let newPos;
  if (afterPos == null && beforePos == null) newPos = 1000;
  else if (afterPos == null) newPos = beforePos - 1000;
  else if (beforePos == null) newPos = afterPos + 1000;
  else newPos = (afterPos + beforePos) / 2;

  upsertCard({ ...card, column_id: targetColumnId, position: newPos });
  return snapshot;
}

/** Roll back an optimistic move using the saved snapshot. */
export function rollbackMove(snapshot) {
  if (snapshot) upsertCard(snapshot);
}
