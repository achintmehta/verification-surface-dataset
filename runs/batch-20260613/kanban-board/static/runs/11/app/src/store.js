// Client-side board state model.
//
// We keep an authoritative-ish map of cards keyed by id, plus the ordered list
// of columns. Ordering within a column is always derived by sorting that
// column's cards by their numeric `position`. This guarantees a total, stable
// order and means a card can only ever live in one column (it has exactly one
// `columnId`).

export class BoardStore {
  constructor() {
    /** @type {Array<{id:string,title:string,position:number}>} */
    this.columns = [];
    /** @type {Map<string, {id:string,columnId:string,text:string,position:number,createdAt:string}>} */
    this.cards = new Map();
  }

  setBoard(board) {
    this.columns = board.columns.map((c) => ({
      id: c.id,
      title: c.title,
      position: c.position,
    }));
    this.cards.clear();
    for (const col of board.columns) {
      for (const card of col.cards) {
        this.cards.set(card.id, { ...card });
      }
    }
  }

  /** Insert or update a single card (used by create/move events). */
  upsertCard(card) {
    this.cards.set(card.id, { ...card });
  }

  /**
   * Apply a canonical column ordering: every card in the payload is upserted
   * with its canonical position/columnId. Because each card carries an explicit
   * columnId, this can never leave a card duplicated across columns.
   */
  applyColumn(column) {
    for (const card of column.cards) {
      this.cards.set(card.id, { ...card });
    }
  }

  /** All cards for a column, sorted into canonical order. */
  cardsForColumn(columnId) {
    const list = [];
    for (const card of this.cards.values()) {
      if (card.columnId === columnId) list.push(card);
    }
    list.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      // Tie-break deterministically so order is total & stable.
      if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return list;
  }

  getCard(id) {
    return this.cards.get(id);
  }
}
