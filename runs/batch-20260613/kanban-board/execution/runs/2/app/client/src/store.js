/**
 * Client-side in-memory store.
 *
 * Holds the canonical board state as received from the server.
 * The UI reads from this store and the SSE handler writes to it.
 *
 * Shape:
 *   columns: Map<columnId, { id, title, position, cards: Map<cardId, card> }>
 *
 * Cards within each column are kept in a sorted array (by position) for
 * rendering, but also indexed by id for O(1) lookup.
 */

export class BoardStore {
  constructor() {
    /** @type {Map<string, Column>} */
    this.columns = new Map();
    /** @type {Map<string, string>} cardId → columnId  (for fast cross-column lookup) */
    this._cardIndex = new Map();
  }

  // -------------------------------------------------------------------------
  // Bulk load (initial fetch)
  // -------------------------------------------------------------------------
  load(columns) {
    this.columns.clear();
    this._cardIndex.clear();

    for (const col of columns) {
      const cards = new Map();
      for (const card of col.cards ?? []) {
        cards.set(card.id, { ...card, position: parseFloat(card.position) });
        this._cardIndex.set(card.id, col.id);
      }
      this.columns.set(col.id, {
        id: col.id,
        title: col.title,
        position: parseFloat(col.position),
        cards,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Ordered helpers
  // -------------------------------------------------------------------------

  /** Returns columns sorted by position */
  getSortedColumns() {
    return [...this.columns.values()].sort((a, b) => a.position - b.position);
  }

  /** Returns cards in a column sorted by position */
  getSortedCards(columnId) {
    const col = this.columns.get(columnId);
    if (!col) return [];
    return [...col.cards.values()].sort((a, b) => a.position - b.position);
  }

  // -------------------------------------------------------------------------
  // Mutations (called by SSE handler)
  // -------------------------------------------------------------------------

  /**
   * Upsert a card (handles both create and move).
   * Removes the card from its previous column if it moved.
   */
  upsertCard(card) {
    const normalizedCard = { ...card, position: parseFloat(card.position) };
    const prevColumnId = this._cardIndex.get(card.id);

    // Remove from old column if it moved
    if (prevColumnId && prevColumnId !== card.column_id) {
      const prevCol = this.columns.get(prevColumnId);
      if (prevCol) prevCol.cards.delete(card.id);
    }

    // Add/update in new column
    const col = this.columns.get(card.column_id);
    if (col) {
      col.cards.set(card.id, normalizedCard);
      this._cardIndex.set(card.id, card.column_id);
    }
  }

  /**
   * Replace all cards in a column (used after renormalization).
   */
  replaceColumnCards(columnId, cards) {
    const col = this.columns.get(columnId);
    if (!col) return;

    // Remove old index entries for this column
    for (const [cardId, colId] of this._cardIndex) {
      if (colId === columnId) this._cardIndex.delete(cardId);
    }

    col.cards.clear();
    for (const card of cards) {
      const normalized = { ...card, position: parseFloat(card.position) };
      col.cards.set(card.id, normalized);
      this._cardIndex.set(card.id, columnId);
    }
  }

  /** Look up a card by id across all columns */
  getCard(cardId) {
    const colId = this._cardIndex.get(cardId);
    if (!colId) return null;
    return this.columns.get(colId)?.cards.get(cardId) ?? null;
  }
}
