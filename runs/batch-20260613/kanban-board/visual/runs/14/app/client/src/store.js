/**
 * Client-side authoritative-ish model of the board.
 *
 * The store holds columns (ordered) and a flat map of cards. Every card lives
 * in exactly one column (enforced by upsertCard removing it from any other
 * column first). Cards within a column are sorted by `position` then `id` to
 * give a total, stable order identical to the server.
 */
export class BoardStore {
  constructor() {
    this.columns = []; // [{ id, title, position }]
    this.cards = new Map(); // id -> { id, columnId, text, position }
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** Replace entire board from server snapshot. */
  setBoard(payload) {
    this.columns = payload.columns.map((c) => ({
      id: c.id,
      title: c.title,
      position: c.position,
    }));
    this.cards.clear();
    for (const col of payload.columns) {
      for (const card of col.cards) {
        this.cards.set(card.id, {
          id: card.id,
          columnId: col.id,
          text: card.text,
          position: Number(card.position),
        });
      }
    }
    this.emit();
  }

  /**
   * Insert or update a card to its canonical column/position. Guarantees the
   * card exists in exactly one place (the map keys by id, so reassigning
   * columnId moves it).
   */
  upsertCard(card) {
    this.cards.set(card.id, {
      id: card.id,
      columnId: card.columnId,
      text: card.text,
      position: Number(card.position),
    });
    this.emit();
  }

  /** Apply a renormalized column broadcast: reset positions/columns. */
  applyRenormalize({ columnId, cards }) {
    for (const card of cards) {
      this.cards.set(card.id, {
        id: card.id,
        columnId,
        text: card.text,
        position: Number(card.position),
      });
    }
    this.emit();
  }

  getColumns() {
    return [...this.columns].sort(
      (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)
    );
  }

  /** Cards of a column in total, stable order. */
  getCards(columnId) {
    const list = [];
    for (const card of this.cards.values()) {
      if (card.columnId === columnId) list.push(card);
    }
    return list.sort(
      (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)
    );
  }

  getCard(id) {
    return this.cards.get(id);
  }
}
