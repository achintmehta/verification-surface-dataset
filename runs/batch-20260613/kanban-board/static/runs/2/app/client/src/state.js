/**
 * Client-side board state store.
 *
 * Holds the canonical list of columns and cards.
 * All mutations go through this module so the DOM renderer always has
 * a single source of truth to reconcile against.
 */

/** @type {Array<{id:string, title:string, position:number, cards:Array}>} */
let columns = [];

/** @returns {Array} deep-cloned columns array */
export function getColumns() {
  return columns;
}

/**
 * Replace the entire board state (used on initial load and full reconcile).
 * @param {Array} newColumns
 */
export function setBoard(newColumns) {
  columns = newColumns.map((col) => ({
    ...col,
    cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
  }));
}

/**
 * Add or update a card in the store.
 * If the card already exists in a different column it is removed from there first.
 * @param {object} card
 */
export function upsertCard(card) {
  // Remove from any existing column
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Insert into target column
  const targetCol = columns.find((c) => c.id === card.column_id);
  if (!targetCol) return; // unknown column – ignore

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);
}

/**
 * Apply renormalized positions to a column's cards.
 * @param {string} columnId
 * @param {Array<{id:string, position:number}>} positions
 */
export function applyRenorm(columnId, positions) {
  const col = columns.find((c) => c.id === columnId);
  if (!col) return;

  const posMap = new Map(positions.map((p) => [p.id, p.position]));
  for (const card of col.cards) {
    if (posMap.has(card.id)) {
      card.position = posMap.get(card.id);
    }
  }
  col.cards.sort((a, b) => a.position - b.position);
}

/**
 * Optimistically move a card within the local state.
 * Returns a snapshot of the previous state so it can be rolled back.
 *
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string|null} afterId
 * @param {string|null} beforeId
 * @returns {{ prevColumnId: string, prevPosition: number } | null}
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find the card
  let card = null;
  let prevColumnId = null;
  let prevPosition = null;

  for (const col of columns) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) {
      card = found;
      prevColumnId = col.id;
      prevPosition = found.position;
      break;
    }
  }
  if (!card) return null;

  // Compute optimistic position
  const targetCol = columns.find((c) => c.id === targetColumnId);
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
  if (afterPos === null && beforePos === null) {
    const maxPos = targetCol.cards.reduce((m, c) => Math.max(m, c.position), 0);
    newPos = maxPos + 1000;
  } else if (afterPos === null) {
    newPos = beforePos / 2;
  } else if (beforePos === null) {
    newPos = afterPos + 1000;
  } else {
    newPos = (afterPos + beforePos) / 2;
  }

  // Apply
  upsertCard({ ...card, column_id: targetColumnId, position: newPos });

  return { prevColumnId, prevPosition };
}

/**
 * Roll back an optimistic move using a saved snapshot.
 * @param {string} cardId
 * @param {string} prevColumnId
 * @param {number} prevPosition
 */
export function rollbackMove(cardId, prevColumnId, prevPosition) {
  // Find the card wherever it currently is
  let card = null;
  for (const col of columns) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) { card = found; break; }
  }
  if (!card) return;
  upsertCard({ ...card, column_id: prevColumnId, position: prevPosition });
}
