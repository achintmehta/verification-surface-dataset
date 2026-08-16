/**
 * Client-side authoritative model of the board.
 *
 * Invariant: every card id appears in exactly one column's `cards` array, and
 * within each column the cards array is the rendered order. All mutations go
 * through this store so a card can never appear in two columns.
 */
export class BoardStore {
  constructor() {
    /** @type {Array<{id, title, position, cards: Array}>} */
    this.columns = [];
    /** id -> card */
    this.cardIndex = new Map();
    /** id -> columnId */
    this.cardColumn = new Map();
  }

  loadBoard(board) {
    this.columns = board.columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: col.cards.map((c) => ({ ...c })),
    }));
    this._reindex();
  }

  _reindex() {
    this.cardIndex.clear();
    this.cardColumn.clear();
    for (const col of this.columns) {
      for (const card of col.cards) {
        this.cardIndex.set(card.id, card);
        this.cardColumn.set(card.id, col.id);
      }
    }
  }

  getColumn(id) {
    return this.columns.find((c) => c.id === id) || null;
  }

  hasCard(id) {
    return this.cardIndex.has(id);
  }

  /**
   * Removes a card from whatever column currently holds it. Returns the removed
   * card (or null).
   */
  _detach(cardId) {
    const colId = this.cardColumn.get(cardId);
    if (colId == null) return null;
    const col = this.getColumn(colId);
    if (!col) return null;
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx === -1) return null;
    const [card] = col.cards.splice(idx, 1);
    this.cardColumn.delete(cardId);
    return card;
  }

  /**
   * Inserts/updates a card in `columnId`, placing it before `beforeId`
   * (or at the end if beforeId is null/absent). Guarantees the card is removed
   * from any prior column first, so it lives in exactly one place.
   */
  upsertAt(card, columnId, beforeId = null) {
    const col = this.getColumn(columnId);
    if (!col) return;

    // Detach from anywhere it may currently exist.
    this._detach(card.id);

    const merged = { ...(this.cardIndex.get(card.id) || {}), ...card, column_id: columnId };
    this.cardIndex.set(card.id, merged);

    let insertIdx = col.cards.length;
    if (beforeId != null) {
      const i = col.cards.findIndex((c) => c.id === beforeId);
      if (i !== -1) insertIdx = i;
    }
    col.cards.splice(insertIdx, 0, merged);
    this.cardColumn.set(card.id, columnId);
  }

  /**
   * Replaces a column's cards array with the given canonical ordering from the
   * server. Cards are looked up/merged from the existing index where possible.
   */
  setColumnOrder(columnId, orderedCards) {
    const col = this.getColumn(columnId);
    if (!col) return;

    // Detach all cards currently in this column from indexes; we'll rebuild.
    for (const c of col.cards) {
      this.cardColumn.delete(c.id);
    }

    col.cards = orderedCards.map((c) => {
      // A card moving INTO this column may still be listed in its old column's
      // array; detach it from there to preserve the single-location invariant.
      const prevCol = this.cardColumn.get(c.id);
      if (prevCol && prevCol !== columnId) {
        const pc = this.getColumn(prevCol);
        if (pc) {
          const idx = pc.cards.findIndex((x) => x.id === c.id);
          if (idx !== -1) pc.cards.splice(idx, 1);
        }
      }
      const merged = { ...(this.cardIndex.get(c.id) || {}), ...c, column_id: columnId };
      this.cardIndex.set(c.id, merged);
      this.cardColumn.set(c.id, columnId);
      return merged;
    });
  }
}
