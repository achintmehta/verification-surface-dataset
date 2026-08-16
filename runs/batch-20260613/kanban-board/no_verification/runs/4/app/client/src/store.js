/**
 * Client-side board state store.
 *
 * Holds the canonical board state (columns + cards) and exposes
 * mutation helpers used by both the drag-and-drop logic and the SSE
 * event handlers.
 *
 * The store is intentionally simple: it is a plain JS object with
 * helper functions.  No framework reactivity is used; callers are
 * responsible for re-rendering after mutations.
 */

/** @type {Array<{id:string, title:string, position:number, cards:Array}>} */
let columns = [];

/* ------------------------------------------------------------------ */
/*  Accessors                                                           */
/* ------------------------------------------------------------------ */

export function getColumns() {
  return columns;
}

export function getColumn(columnId) {
  return columns.find((c) => c.id === columnId) ?? null;
}

export function getCard(cardId) {
  for (const col of columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Initialise from server board state                                  */
/* ------------------------------------------------------------------ */

export function initBoard(serverColumns) {
  columns = serverColumns.map((col) => ({
    ...col,
    cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
  }));
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Add or update a card in the store.
 * If the card already exists in a different column it is removed first
 * (prevents duplication during cross-column moves).
 */
export function upsertCard(card) {
  // Remove from any existing column.
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Insert into the target column.
  const targetCol = columns.find((c) => c.id === card.column_id);
  if (!targetCol) {
    console.warn(`[store] upsertCard: unknown column ${card.column_id}`);
    return;
  }

  targetCol.cards.push(card);
  sortColumn(targetCol);
}

/**
 * Replace all cards in a column with the provided ordered list.
 * Used when the server broadcasts a renormalised column.
 */
export function replaceColumnCards(columnId, cards) {
  const col = columns.find((c) => c.id === columnId);
  if (!col) return;
  col.cards = [...cards].sort((a, b) => a.position - b.position);
}

/**
 * Optimistically reorder a card within the store without waiting for
 * the server response.  The card is placed between `afterId` and
 * `beforeId` in the target column.
 *
 * Returns a snapshot of the previous state so the caller can roll back
 * if the server rejects the move.
 */
export function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Snapshot for rollback.
  const snapshot = columns.map((col) => ({
    ...col,
    cards: col.cards.map((c) => ({ ...c })),
  }));

  // Find and detach the card.
  let card = null;
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      [card] = col.cards.splice(idx, 1);
      break;
    }
  }
  if (!card) return snapshot;

  // Attach to target column.
  card = { ...card, column_id: targetColumnId };
  const targetCol = columns.find((c) => c.id === targetColumnId);
  if (!targetCol) return snapshot;

  // Compute an optimistic position.
  const afterCard  = afterId  ? targetCol.cards.find((c) => c.id === afterId)  : null;
  const beforeCard = beforeId ? targetCol.cards.find((c) => c.id === beforeId) : null;

  const afterPos  = afterCard  ? afterCard.position  : null;
  const beforePos = beforeCard ? beforeCard.position : null;

  if (afterPos === null && beforePos === null) {
    card.position = 1000;
  } else if (afterPos === null) {
    card.position = beforePos / 2;
  } else if (beforePos === null) {
    card.position = afterPos + 1000;
  } else {
    card.position = (afterPos + beforePos) / 2;
  }

  targetCol.cards.push(card);
  sortColumn(targetCol);

  return snapshot;
}

/**
 * Roll back to a previous snapshot (used when a server move fails).
 */
export function rollback(snapshot) {
  columns = snapshot;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function sortColumn(col) {
  col.cards.sort((a, b) => a.position - b.position);
}
