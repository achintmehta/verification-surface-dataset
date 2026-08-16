/**
 * Client-side board state store.
 *
 * The store holds the authoritative (server-reconciled) board as an array of
 * column objects, each with a `cards` array sorted by `position`.
 *
 * Optimistic updates mutate a *draft* copy; the draft is replaced by the
 * server's canonical state when SSE events arrive.
 */

/** @type {Array<{id:string, title:string, position:number, cards:Array}>} */
let columns = [];

/* ------------------------------------------------------------------ */
/*  Accessors                                                           */
/* ------------------------------------------------------------------ */

export function getColumns() {
  return columns;
}

export function getColumn(id) {
  return columns.find((c) => c.id === id) ?? null;
}

export function getCard(cardId) {
  for (const col of columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Full board load (initial fetch)                                     */
/* ------------------------------------------------------------------ */

export function loadBoard(serverColumns) {
  columns = serverColumns.map((col) => ({
    ...col,
    cards: [...col.cards].sort((a, b) => a.position - b.position),
  }));
}

/* ------------------------------------------------------------------ */
/*  Optimistic card creation                                            */
/* ------------------------------------------------------------------ */

/**
 * Insert a temporary card into the local state immediately.
 * Returns the temp card object.
 */
export function optimisticAddCard(columnId, text, tempId) {
  const col = getColumn(columnId);
  if (!col) return null;

  const maxPos = col.cards.length
    ? Math.max(...col.cards.map((c) => c.position))
    : 0;

  const tempCard = {
    id: tempId,
    column_id: columnId,
    text,
    position: maxPos + 1000,
    created_at: new Date().toISOString(),
    _optimistic: true,
  };

  col.cards.push(tempCard);
  return tempCard;
}

/**
 * Replace a temporary card with the server's canonical card.
 */
export function confirmCard(tempId, serverCard) {
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === tempId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }
  applyCardUpsert(serverCard);
}

/**
 * Remove a temporary card (on error).
 */
export function revertCard(tempId) {
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === tempId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Optimistic move                                                     */
/* ------------------------------------------------------------------ */

/**
 * Optimistically move a card in local state.
 * `beforeId` = card above the slot, `afterId` = card below the slot (both in target column).
 */
export function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  // Remove card from its current column
  let card = null;
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      [card] = col.cards.splice(idx, 1);
      break;
    }
  }
  if (!card) return;

  const targetCol = getColumn(targetColumnId);
  if (!targetCol) return;

  // Compute optimistic position
  const beforeCard = beforeId ? targetCol.cards.find((c) => c.id === beforeId) : null;
  const afterCard = afterId ? targetCol.cards.find((c) => c.id === afterId) : null;

  const beforePos = beforeCard ? beforeCard.position : null;
  const afterPos = afterCard ? afterCard.position : null;

  let newPos;
  if (beforePos === null && afterPos === null) newPos = 1000;
  else if (beforePos === null) newPos = afterPos - 1000;
  else if (afterPos === null) newPos = beforePos + 1000;
  else newPos = (beforePos + afterPos) / 2;

  card = { ...card, column_id: targetColumnId, position: newPos, _optimistic: true };
  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);
}

/* ------------------------------------------------------------------ */
/*  Server-authoritative reconciliation                                 */
/* ------------------------------------------------------------------ */

/**
 * Upsert a card from the server (card-created / card-moved events).
 * Ensures the card exists in exactly one column.
 */
export function applyCardUpsert(serverCard) {
  // Remove from any column it currently occupies
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === serverCard.id);
    if (idx !== -1) col.cards.splice(idx, 1);
  }

  // Insert into the correct column
  const targetCol = getColumn(serverCard.column_id);
  if (!targetCol) return;

  targetCol.cards.push({ ...serverCard });
  targetCol.cards.sort((a, b) => a.position - b.position);
}

/**
 * Replace all cards in a column with the server's canonical ordered list.
 * Used for `column-reorder` events (renormalization).
 */
export function applyColumnReorder(columnId, serverCards) {
  const col = getColumn(columnId);
  if (!col) return;
  col.cards = [...serverCards].sort((a, b) => a.position - b.position);
}
