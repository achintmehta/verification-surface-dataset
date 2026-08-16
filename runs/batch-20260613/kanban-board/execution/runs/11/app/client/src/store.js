// Client-side board store.
//
// Holds the board as an ordered list of columns, each with an ordered list of
// cards. The store is the single source of truth for rendering. It supports:
//   - replacing the whole board (initial load)
//   - optimistic mutations (move a card immediately on drop)
//   - applying authoritative server events (create / move), reconciling any
//     optimistic guess against the canonical ordering.
//
// Invariant enforced everywhere: a card exists in exactly one column.

export class BoardStore {
  constructor() {
    this.columns = []; // [{ id, title, position, cards: [{id, columnId, text, position}] }]
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  setBoard(board) {
    this.columns = board.columns.map((c) => ({
      id: c.id,
      title: c.title,
      position: c.position,
      cards: (c.cards || []).map(normalizeCard)
    }));
    this.emit();
  }

  getColumn(columnId) {
    return this.columns.find((c) => c.id === columnId) || null;
  }

  findCard(cardId) {
    for (const col of this.columns) {
      const idx = col.cards.findIndex((c) => c.id === cardId);
      if (idx !== -1) return { column: col, index: idx, card: col.cards[idx] };
    }
    return null;
  }

  // Remove a card from wherever it currently lives. Guarantees uniqueness.
  _detach(cardId) {
    for (const col of this.columns) {
      const idx = col.cards.findIndex((c) => c.id === cardId);
      if (idx !== -1) {
        const [card] = col.cards.splice(idx, 1);
        return card;
      }
    }
    return null;
  }

  /**
   * Optimistically move a card into `columnId` relative to neighbors.
   * `afterId` = card that should be directly above; `beforeId` = directly below.
   * Returns true on success.
   */
  optimisticMove(cardId, { columnId, beforeId, afterId }) {
    const targetCol = this.getColumn(columnId);
    if (!targetCol) return false;

    const existing = this.findCard(cardId);
    if (!existing) return false;
    const moving = { ...existing.card, columnId };

    // Detach from current location (also removes potential duplicates).
    this._detach(cardId);

    const insertIndex = this._resolveInsertIndex(targetCol, { beforeId, afterId, excludeId: cardId });
    targetCol.cards.splice(insertIndex, 0, moving);
    this.emit();
    return true;
  }

  _resolveInsertIndex(col, { beforeId, afterId, excludeId }) {
    const cards = col.cards;
    if (afterId) {
      const i = cards.findIndex((c) => c.id === afterId && c.id !== excludeId);
      if (i !== -1) return i + 1;
    }
    if (beforeId) {
      const i = cards.findIndex((c) => c.id === beforeId && c.id !== excludeId);
      if (i !== -1) return i;
    }
    // Default: append to end.
    return cards.length;
  }

  /**
   * Apply an authoritative "card-created" event.
   */
  applyCreated(card) {
    const c = normalizeCard(card);
    // Remove any stale copy, then insert in canonical position.
    this._detach(c.id);
    const col = this.getColumn(c.columnId);
    if (!col) return;
    this._insertByPosition(col, c);
    this.emit();
  }

  /**
   * Apply an authoritative "card-moved" event.
   * If the server renormalized the column, replace that column's cards wholesale
   * with the canonical ordering. Otherwise place the card by its canonical
   * position. Either way we reconcile/snap to server order.
   */
  applyMoved({ card, columnId, renormalized, column }) {
    const c = normalizeCard(card);

    // Detach from any current location across all columns (enforces uniqueness).
    this._detach(c.id);

    if (renormalized && column) {
      const col = this.getColumn(column.id);
      if (col) {
        col.cards = column.cards.map(normalizeCard);
        this.emit();
        return;
      }
    }

    const col = this.getColumn(columnId);
    if (!col) return;
    this._insertByPosition(col, c);
    this.emit();
  }

  _insertByPosition(col, card) {
    let idx = col.cards.findIndex((c) => card.position < c.position);
    if (idx === -1) idx = col.cards.length;
    col.cards.splice(idx, 0, card);
  }
}

function normalizeCard(card) {
  return {
    id: card.id,
    columnId: card.columnId,
    text: card.text,
    position: Number(card.position)
  };
}
