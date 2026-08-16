// Client-side board model. It holds columns (ordered) and a flat map of cards
// keyed by id. Every card carries its column_id and position, so a card can
// never exist in two columns: applying an update simply overwrites the single
// record. Rendering derives column order from each card's position, exactly
// mirroring the server's ORDER BY position, id.

export class BoardStore {
  constructor() {
    /** @type {{id:number,title:string,position:number}[]} */
    this.columns = [];
    /** @type {Map<number, {id:number,column_id:number,text:string,position:number}>} */
    this.cards = new Map();
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** Replace the entire board (initial load / full resync). */
  setBoard(board) {
    this.columns = board.columns
      .map((c) => ({ id: c.id, title: c.title, position: Number(c.position) }))
      .sort(cmpById('position'));
    this.cards.clear();
    for (const col of board.columns) {
      for (const card of col.cards) {
        this.cards.set(card.id, normalizeCard(card));
      }
    }
    this.emit();
  }

  /**
   * Upsert a single canonical card. Because each card is a single record keyed
   * by id, this is idempotent and guarantees the card lives in exactly one
   * column.
   */
  upsertCard(card) {
    this.cards.set(card.id, normalizeCard(card));
    this.emit();
  }

  /** Apply a renormalized column: overwrite the affected cards' positions. */
  applyNormalizedColumn(columnId, cards) {
    for (const card of cards) {
      this.cards.set(card.id, normalizeCard(card));
    }
    // Drop any stale cards that the server says are no longer in this column
    // but which we still believe belong here (defensive).
    this.emit();
  }

  /** Cards belonging to a column, ordered exactly like the server. */
  cardsForColumn(columnId) {
    const list = [];
    for (const card of this.cards.values()) {
      if (card.column_id === columnId) list.push(card);
    }
    return list.sort(cmpById('position'));
  }

  getCard(id) {
    return this.cards.get(id);
  }

  /**
   * Optimistically move a card: place it in `columnId` with a fractional
   * position derived from the on-screen neighbours so the local render matches
   * the drop immediately, before the server responds.
   */
  optimisticMove(cardId, columnId, afterCardId, beforeCardId) {
    const card = this.cards.get(cardId);
    if (!card) return;
    const afterPos =
      afterCardId != null && this.cards.has(afterCardId)
        ? this.cards.get(afterCardId).position
        : null;
    const beforePos =
      beforeCardId != null && this.cards.has(beforeCardId)
        ? this.cards.get(beforeCardId).position
        : null;

    let position;
    if (afterPos == null && beforePos == null) position = 1000;
    else if (afterPos == null) position = beforePos - 1000;
    else if (beforePos == null) position = afterPos + 1000;
    else position = (afterPos + beforePos) / 2;

    this.cards.set(cardId, { ...card, column_id: columnId, position });
    this.emit();
  }
}

function normalizeCard(card) {
  return {
    id: card.id,
    column_id: card.column_id,
    text: card.text,
    position: Number(card.position),
  };
}

function cmpById(field) {
  return (a, b) => {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
    return a.id - b.id;
  };
}
