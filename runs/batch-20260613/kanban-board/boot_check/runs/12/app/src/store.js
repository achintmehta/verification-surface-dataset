/**
 * Client-side authoritative model of the board.
 *
 * The store holds a Map of columns and a Map of cards. Each card knows its
 * column_id and position. The store always derives ordered cards by sorting
 * on (position, id), matching the server's canonical ordering exactly, which
 * guarantees a total, stable order and that a card lives in exactly one column.
 */

export class BoardStore {
  constructor() {
    this.columns = new Map(); // id -> { id, title, position }
    this.columnOrder = []; // ordered column ids
    this.cards = new Map(); // id -> { id, column_id, text, position, created_at }
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** Replace the whole board from a fresh GET /api/board response. */
  setBoard(data) {
    this.columns.clear();
    this.cards.clear();
    this.columnOrder = [];
    for (const col of data.columns) {
      this.columns.set(col.id, { id: col.id, title: col.title, position: col.position });
      this.columnOrder.push(col.id);
      for (const card of col.cards) {
        this.cards.set(card.id, { ...card });
      }
    }
    this.emit();
  }

  /** Upsert a single canonical card (from create/move events or responses). */
  upsertCard(card) {
    this.cards.set(card.id, { ...card });
    this.emit();
  }

  /**
   * Apply a renormalized column: replace all positions/column for cards in
   * that column with the server's canonical values.
   */
  applyColumnReorder({ columnId, cards }) {
    for (const card of cards) {
      this.cards.set(card.id, { ...card });
    }
    this.emit();
  }

  /**
   * Optimistically move a card locally. We assign a provisional fractional
   * position between the neighbours so the DOM updates immediately; the server
   * response / SSE event will overwrite this with the canonical position.
   */
  optimisticMove(cardId, columnId, beforeId, afterId) {
    const card = this.cards.get(cardId);
    if (!card) return;

    const siblings = this.getCardsForColumn(columnId).filter((c) => c.id !== cardId);
    const afterPos = afterId != null ? this.cards.get(afterId)?.position : null;
    const beforePos = beforeId != null ? this.cards.get(beforeId)?.position : null;

    let position;
    if (afterPos != null && beforePos != null) {
      position = (afterPos + beforePos) / 2;
    } else if (afterPos != null) {
      position = afterPos + 1000;
    } else if (beforePos != null) {
      position = beforePos - 1000;
    } else {
      // empty column
      position = siblings.length === 0 ? 1000 : siblings[0].position - 1000;
    }

    card.column_id = columnId;
    card.position = position;
    this.cards.set(cardId, { ...card });
    this.emit();
  }

  getColumns() {
    return this.columnOrder.map((id) => this.columns.get(id)).filter(Boolean);
  }

  /** Cards in a column, totally ordered by (position, id). */
  getCardsForColumn(columnId) {
    const result = [];
    for (const card of this.cards.values()) {
      if (card.column_id === columnId) result.push(card);
    }
    result.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return a.id - b.id;
    });
    return result;
  }
}
