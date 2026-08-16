// Client-side authoritative model of the board. Cards are stored in a flat map
// keyed by id; column membership and ordering are derived from each card's
// `column_id` and `position`. This makes SSE reconciliation trivial: we update
// the single card record and re-derive ordering, guaranteeing a card never
// lives in two columns.

export class BoardStore {
  constructor() {
    this.columns = []; // [{id, title, position}]
    this.cards = new Map(); // id -> {id, column_id, text, position, created_at}
  }

  load(payload) {
    this.columns = payload.columns.map((c) => ({
      id: c.id,
      title: c.title,
      position: c.position,
    }));
    this.cards.clear();
    for (const col of payload.columns) {
      for (const card of col.cards) {
        this.cards.set(card.id, { ...card, position: Number(card.position) });
      }
    }
  }

  /** Apply a canonical card (from create or move). */
  upsertCard(card) {
    this.cards.set(card.id, { ...card, position: Number(card.position) });
  }

  /** Apply a renormalization batch: [{id, column_id, position}, ...]. */
  applyRenormalized(list) {
    for (const r of list || []) {
      const existing = this.cards.get(r.id);
      if (existing) {
        existing.column_id = r.column_id;
        existing.position = Number(r.position);
      }
    }
  }

  getColumn(columnId) {
    return this.columns.find((c) => c.id === columnId);
  }

  /** Ordered cards for a column (total, stable order). */
  cardsForColumn(columnId) {
    const list = [];
    for (const card of this.cards.values()) {
      if (card.column_id === columnId) list.push(card);
    }
    list.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      // Tie-break deterministically so the order is total and stable.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return list;
  }

  /**
   * Optimistically move a card to a target column at the index implied by the
   * neighbor card ids. We assign a provisional fractional position so the
   * derived order matches the drop immediately; the server's canonical value
   * replaces it on the SSE echo.
   */
  optimisticMove(cardId, columnId, beforeId, afterId) {
    const card = this.cards.get(cardId);
    if (!card) return;
    const afterPos = this._posOf(afterId, columnId, cardId);
    const beforePos = this._posOf(beforeId, columnId, cardId);
    let pos;
    if (afterPos == null && beforePos == null) pos = 1000;
    else if (afterPos == null) pos = beforePos - 1;
    else if (beforePos == null) pos = afterPos + 1;
    else pos = (afterPos + beforePos) / 2;
    card.column_id = columnId;
    card.position = pos;
  }

  _posOf(id, columnId, movingId) {
    if (!id || id === movingId) return null;
    const c = this.cards.get(id);
    if (!c || c.column_id !== columnId) return null;
    return c.position;
  }
}
