// In-memory representation of the board. This is the single source of truth the
// renderer reads from. It is updated by:
//   - the initial GET /api/board load,
//   - optimistic local moves (applied immediately on drop),
//   - SSE events carrying canonical server state (which override optimistic).
//
// Cards are stored in a flat map keyed by id so a card can only ever live in
// one column at a time (its `columnId` field). Ordering within a column is
// derived from each card's numeric `position`.

export function createStore() {
  /** @type {Map<string, {id,title,position}>} */
  const columns = new Map();
  const columnOrder = [];
  /** @type {Map<string, {id,columnId,text,position,createdAt}>} */
  const cards = new Map();

  function setBoard(board) {
    columns.clear();
    columnOrder.length = 0;
    cards.clear();
    for (const col of board.columns) {
      columns.set(col.id, { id: col.id, title: col.title, position: col.position });
      columnOrder.push(col.id);
      for (const card of col.cards) {
        cards.set(card.id, { ...card });
      }
    }
  }

  function getColumns() {
    return columnOrder.map((id) => columns.get(id));
  }

  /**
   * Returns cards for a column, ordered by position then a stable tiebreaker.
   */
  function getCardsForColumn(columnId) {
    const list = [];
    for (const card of cards.values()) {
      if (card.columnId === columnId) list.push(card);
    }
    list.sort(compareCards);
    return list;
  }

  function getCard(id) {
    return cards.get(id);
  }

  function hasCard(id) {
    return cards.has(id);
  }

  /**
   * Upserts a card. Because cards are keyed by id, this atomically moves the
   * card to whatever column its data specifies — it can never end up in two.
   */
  function upsertCard(card) {
    cards.set(card.id, { ...card });
  }

  /**
   * Applies a canonical normalized order for a column (from the server) by
   * overwriting positions for every included card.
   */
  function applyNormalized(normalized) {
    for (const card of normalized) {
      cards.set(card.id, { ...card });
    }
  }

  return {
    setBoard,
    getColumns,
    getCardsForColumn,
    getCard,
    hasCard,
    upsertCard,
    applyNormalized,
  };
}

function compareCards(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  const ca = a.createdAt || '';
  const cb = b.createdAt || '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
