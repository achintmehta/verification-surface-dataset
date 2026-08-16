/**
 * Client-side board state.
 *
 * Columns are stored in an ordered array.
 * Cards are stored in a flat map keyed by id, plus each column has an ordered
 * array of card ids.
 *
 * This separation makes it easy to:
 *   - look up a card by id in O(1)
 *   - render a column's cards in order
 *   - move a card between columns without touching other columns
 */

export class BoardState {
  constructor() {
    /** @type {{ id: string, title: string, position: number }[]} */
    this.columns = [];

    /** @type {Map<string, { id: string, column_id: string, text: string, position: number, created_at: string }>} */
    this.cards = new Map();

    /** @type {Map<string, string[]>} columnId → ordered card ids */
    this.columnCards = new Map();
  }

  /** Replace the entire board state from the server's /api/board response. */
  loadBoard({ columns }) {
    this.columns = columns.map(c => ({ id: c.id, title: c.title, position: c.position }));
    this.cards.clear();
    this.columnCards.clear();

    for (const col of columns) {
      const ids = [];
      for (const card of col.cards) {
        this.cards.set(card.id, card);
        ids.push(card.id);
      }
      this.columnCards.set(col.id, ids);
    }
  }

  /** Upsert a card (from card:created or card:moved events). */
  upsertCard(card) {
    const existing = this.cards.get(card.id);

    // Remove from old column if it moved
    if (existing && existing.column_id !== card.column_id) {
      this._removeCardFromColumn(card.id, existing.column_id);
    }

    this.cards.set(card.id, card);

    // Insert into new column in sorted order
    const ids = this.columnCards.get(card.column_id) || [];
    if (!ids.includes(card.id)) {
      ids.push(card.id);
    }
    // Re-sort by position
    ids.sort((a, b) => {
      const ca = this.cards.get(a);
      const cb = this.cards.get(b);
      return (ca?.position ?? 0) - (cb?.position ?? 0);
    });
    this.columnCards.set(card.column_id, ids);
  }

  /** Replace all cards in a column (from column:reordered event). */
  reorderColumn(columnId, cards) {
    // Remove old cards from this column
    const oldIds = this.columnCards.get(columnId) || [];
    for (const id of oldIds) {
      this.cards.delete(id);
    }

    const newIds = [];
    for (const card of cards) {
      this.cards.set(card.id, card);
      newIds.push(card.id);
    }
    // cards are already sorted by server
    this.columnCards.set(columnId, newIds);
  }

  /** Get ordered cards for a column. */
  getColumnCards(columnId) {
    const ids = this.columnCards.get(columnId) || [];
    return ids.map(id => this.cards.get(id)).filter(Boolean);
  }

  _removeCardFromColumn(cardId, columnId) {
    const ids = this.columnCards.get(columnId);
    if (!ids) return;
    const idx = ids.indexOf(cardId);
    if (idx !== -1) ids.splice(idx, 1);
  }
}
