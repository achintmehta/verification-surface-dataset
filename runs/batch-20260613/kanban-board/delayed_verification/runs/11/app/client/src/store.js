/**
 * Client-side board model. Holds the canonical-ish state and exposes mutation
 * helpers used for both optimistic updates and server reconciliation.
 *
 * Invariant: every card id exists in exactly one column at all times.
 */
export class BoardStore {
  constructor() {
    // columns: array of { id, title, position, cards: [card] }
    this.columns = [];
    // index: cardId -> card object (the same reference held in a column)
    this._listeners = new Set();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  setBoard(columns) {
    this.columns = columns.map((c) => ({
      ...c,
      cards: [...c.cards].sort(sortCards),
    }));
    this._emit();
  }

  getColumn(columnId) {
    return this.columns.find((c) => c.id === columnId);
  }

  findCard(cardId) {
    for (const col of this.columns) {
      const card = col.cards.find((c) => c.id === cardId);
      if (card) return { card, column: col };
    }
    return null;
  }

  /**
   * Remove a card from wherever it currently lives. Returns the removed card
   * or null. Used to keep the single-column invariant.
   */
  _removeCard(cardId) {
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
   * Upsert a card into a target column, enforcing single-column membership.
   * Re-sorts the column by position to keep ordering total/stable.
   */
  upsertCard(card) {
    const existing = this._removeCard(card.id);
    const merged = existing ? { ...existing, ...card } : { ...card };
    const col = this.getColumn(card.columnId);
    if (!col) return;
    col.cards.push(merged);
    col.cards.sort(sortCards);
    this._emit();
  }

  /**
   * Optimistically place a card at a DOM index within a column (used during
   * drag). We assign a provisional fractional position so re-sorting keeps the
   * visual order until the server responds.
   */
  optimisticMove(cardId, columnId, domIndex) {
    const removed = this._removeCard(cardId);
    if (!removed) return;
    const col = this.getColumn(columnId);
    if (!col) return;

    const before = col.cards[domIndex];
    const after = col.cards[domIndex - 1];
    const afterPos = after ? after.position : null;
    const beforePos = before ? before.position : null;

    let position;
    if (afterPos == null && beforePos == null) position = 1000;
    else if (afterPos == null) position = beforePos - 1000;
    else if (beforePos == null) position = afterPos + 1000;
    else position = (afterPos + beforePos) / 2;

    const moved = { ...removed, columnId, position };
    col.cards.splice(domIndex, 0, moved);
    this._emit();
  }

  /**
   * Reconcile against authoritative server state for a single column. Replaces
   * the target column's cards with the server snapshot, and removes the moved
   * card from any other column (single-column invariant).
   */
  reconcileColumn(snapshot, movedCard) {
    if (movedCard) {
      // Remove from any column other than the canonical target.
      for (const col of this.columns) {
        if (col.id === snapshot.columnId) continue;
        const idx = col.cards.findIndex((c) => c.id === movedCard.id);
        if (idx !== -1) col.cards.splice(idx, 1);
      }
    }
    const col = this.getColumn(snapshot.columnId);
    if (col) {
      col.cards = [...snapshot.cards].sort(sortCards);
    }
    this._emit();
  }
}

export function sortCards(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  const ca = String(a.createdAt || '');
  const cb = String(b.createdAt || '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
