// Client-side board state store

class BoardStore {
  constructor() {
    this.columns = []; // Each column: { id, title, position, cards: [...] }
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) {
      fn(this.columns);
    }
  }

  setBoard(columns) {
    this.columns = columns;
    this.notify();
  }

  getColumn(columnId) {
    return this.columns.find(c => c.id === columnId);
  }

  getCard(cardId) {
    for (const col of this.columns) {
      const card = col.cards.find(c => c.id === cardId);
      if (card) return { card, column: col };
    }
    return null;
  }

  // Add card to a column's card list (sorted by position)
  addCard(card) {
    const col = this.getColumn(card.column_id);
    if (!col) return;

    // Remove from any existing column first (safety)
    this.removeCardFromAll(card.id);

    // Re-get column after removal
    const targetCol = this.getColumn(card.column_id);
    if (!targetCol) return;

    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);
    this.notify();
  }

  removeCardFromAll(cardId) {
    for (const col of this.columns) {
      const idx = col.cards.findIndex(c => c.id === cardId);
      if (idx !== -1) {
        col.cards.splice(idx, 1);
      }
    }
  }

  // Move a card to a new column/position
  moveCard(card, sourceColumnId, targetColumnId) {
    // Remove from all columns
    this.removeCardFromAll(card.id);

    // Add to target column
    const targetCol = this.getColumn(targetColumnId);
    if (!targetCol) return;

    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);
    this.notify();
  }

  // Apply renormalized card positions for a column
  applyRenormalization(columnId, renormalizedCards) {
    const col = this.getColumn(columnId);
    if (!col) return;

    for (const rc of renormalizedCards) {
      const existing = col.cards.find(c => c.id === rc.id);
      if (existing) {
        existing.position = rc.position;
      }
    }
    col.cards.sort((a, b) => a.position - b.position);
    this.notify();
  }

  deleteCard(cardId) {
    this.removeCardFromAll(cardId);
    this.notify();
  }

  // Get ordered card IDs in a column (for reconciliation)
  getColumnCardIds(columnId) {
    const col = this.getColumn(columnId);
    if (!col) return [];
    return col.cards.map(c => c.id);
  }
}

export const store = new BoardStore();
