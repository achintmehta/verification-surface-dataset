/**
 * Client-side board state.
 *
 * The state is a Map<columnId, { ...column, cards: Card[] }> where cards are
 * kept sorted by position ascending.
 *
 * All mutations go through this module so the DOM renderer always has a
 * single source of truth.
 */

/** @type {Map<string, { id: string, title: string, position: number, cards: object[] }>} */
const columns = new Map();

/** Ordered column ids (by column.position) */
let columnOrder = [];

/* ------------------------------------------------------------------ */
/*  Initialise from full board payload                                  */
/* ------------------------------------------------------------------ */
export function initState(boardData) {
  columns.clear();
  columnOrder = [];

  for (const col of boardData.columns) {
    columns.set(col.id, {
      id:       col.id,
      title:    col.title,
      position: col.position,
      cards:    sortCards(col.cards ?? []),
    });
  }

  columnOrder = boardData.columns
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((c) => c.id);
}

/* ------------------------------------------------------------------ */
/*  Accessors                                                           */
/* ------------------------------------------------------------------ */
export function getColumnOrder() {
  return columnOrder;
}

export function getColumn(id) {
  return columns.get(id);
}

export function getAllColumns() {
  return columnOrder.map((id) => columns.get(id));
}

/* ------------------------------------------------------------------ */
/*  Card mutations                                                      */
/* ------------------------------------------------------------------ */

/**
 * Upsert a card into the correct column, removing it from any other column.
 * Used for both card-created and card-moved events.
 */
export function upsertCard(card) {
  // Remove from any column that currently holds it
  for (const col of columns.values()) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Insert into target column
  const col = columns.get(card.column_id);
  if (!col) return; // unknown column – ignore

  col.cards.push(card);
  col.cards = sortCards(col.cards);
}

/**
 * Replace all cards in a column (used after a renorm broadcast).
 */
export function replaceColumnCards(columnId, cards) {
  const col = columns.get(columnId);
  if (!col) return;
  col.cards = sortCards(cards);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */
function sortCards(cards) {
  return cards.slice().sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    // Stable tie-break by created_at then id
    return (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
           a.id.localeCompare(b.id);
  });
}
