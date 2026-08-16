/**
 * Client-side board state store.
 *
 * Holds the canonical board as received from the server.
 * Provides helpers to apply server events and query the state.
 *
 * Shape:
 *   columns: Map<columnId, { id, title, position, cards: Map<cardId, card> }>
 *   columnOrder: string[]   (sorted by column.position)
 */

export class BoardState {
  constructor() {
    /** @type {Map<string, { id:string, title:string, position:number, cards: Map<string,object> }>} */
    this.columns = new Map();
    /** @type {string[]} column ids sorted by position */
    this.columnOrder = [];
  }

  /** Replace the entire board state from the server's /api/board response. */
  loadBoard({ columns }) {
    this.columns.clear();
    for (const col of columns) {
      const cards = new Map();
      for (const card of col.cards) {
        cards.set(card.id, { ...card, position: Number(card.position) });
      }
      this.columns.set(col.id, {
        id: col.id,
        title: col.title,
        position: Number(col.position),
        cards,
      });
    }
    this._rebuildColumnOrder();
  }

  /** Apply a card:created event. */
  applyCardCreated(card) {
    const col = this.columns.get(card.column_id);
    if (!col) return;
    col.cards.set(card.id, { ...card, position: Number(card.position) });
  }

  /** Apply a card:moved event (single card update). */
  applyCardMoved(card) {
    // Remove from any column that currently holds this card
    for (const col of this.columns.values()) {
      col.cards.delete(card.id);
    }
    const targetCol = this.columns.get(card.column_id);
    if (!targetCol) return;
    targetCol.cards.set(card.id, { ...card, position: Number(card.position) });
  }

  /** Apply a column:reordered event (full column card list). */
  applyColumnReordered({ columnId, cards }) {
    const col = this.columns.get(columnId);
    if (!col) return;
    col.cards.clear();
    for (const card of cards) {
      col.cards.set(card.id, { ...card, position: Number(card.position) });
    }
  }

  /** Return cards for a column sorted by position. */
  getSortedCards(columnId) {
    const col = this.columns.get(columnId);
    if (!col) return [];
    return [...col.cards.values()].sort((a, b) => a.position - b.position);
  }

  /** Return columns sorted by position. */
  getSortedColumns() {
    return this.columnOrder.map((id) => this.columns.get(id)).filter(Boolean);
  }

  _rebuildColumnOrder() {
    this.columnOrder = [...this.columns.values()]
      .sort((a, b) => a.position - b.position)
      .map((c) => c.id);
  }
}
