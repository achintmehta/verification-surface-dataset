/**
 * Client-side board store. Maintains the authoritative-ish board state as a
 * list of columns (each ordered) plus a map of cardId -> card. The server is
 * the source of truth; optimistic updates are applied locally then reconciled
 * when SSE/HTTP responses arrive.
 *
 * Each card carries a numeric `position`. Within a column, cards are kept
 * sorted by (position, id), mirroring the server's total ordering. This makes
 * ordering total and stable, and guarantees a card never appears twice (we key
 * by id and a card belongs to exactly one column).
 */

export class BoardStore {
  constructor() {
    this.columns = []; // [{ id, title, position }]
    this.cards = new Map(); // id -> { id, columnId, text, position, createdAt }
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** Replace entire state from server board payload. */
  setBoard(payload) {
    this.columns = payload.columns
      .map((c) => ({ id: c.id, title: c.title, position: c.position }))
      .sort(byPositionId);
    this.cards.clear();
    for (const col of payload.columns) {
      for (const card of col.cards) {
        this.cards.set(card.id, { ...card });
      }
    }
    this.emit();
  }

  /** Upsert a single card (from create/move events or local optimistic move). */
  upsertCard(card) {
    this.cards.set(card.id, { ...card });
    this.emit();
  }

  /**
   * Apply a renormalized column: replace all positions for cards in the column
   * with the canonical ordering provided by the server.
   */
  applyRenormalizedColumn(columnId, cards) {
    if (!cards) return;
    // Remove existing cards that were in this column but are not present
    // (shouldn't normally happen, but keeps us consistent).
    const incomingIds = new Set(cards.map((c) => c.id));
    for (const [id, card] of this.cards) {
      if (card.columnId === columnId && !incomingIds.has(id)) {
        this.cards.delete(id);
      }
    }
    for (const card of cards) {
      this.cards.set(card.id, { ...card });
    }
    this.emit();
  }

  /** Cards for a column, sorted by (position, id). */
  cardsForColumn(columnId) {
    const out = [];
    for (const card of this.cards.values()) {
      if (card.columnId === columnId) out.push(card);
    }
    out.sort(byPositionId);
    return out;
  }

  getCard(id) {
    return this.cards.get(id);
  }
}

function byPositionId(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
