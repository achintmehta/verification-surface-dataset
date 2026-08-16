// Client-side board model. The model mirrors the server's authoritative
// state: a list of columns (ordered) each holding an ordered list of cards.
// All rendering derives from this model so a card can only ever appear in
// exactly one place.

export class BoardStore {
  constructor() {
    /** @type {Array<{id:string,title:string,position:number,cards:Card[]}>} */
    this.columns = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  /** Replace the whole board (e.g. on initial load). */
  setBoard(board) {
    this.columns = board.columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: Number(col.position),
      cards: col.cards.map(normalizeCard),
    }));
    this.sortAll();
    this.emit();
  }

  getColumn(columnId) {
    return this.columns.find((c) => c.id === columnId) || null;
  }

  findCard(cardId) {
    for (const col of this.columns) {
      const card = col.cards.find((c) => c.id === cardId);
      if (card) return { card, column: col };
    }
    return null;
  }

  sortAll() {
    for (const col of this.columns) {
      col.cards.sort(compareCards);
    }
  }

  /**
   * Insert or update a card from canonical (server) data, ensuring it lives
   * in exactly one column. Used for both creates and moves.
   */
  upsertCard(rawCard) {
    const card = normalizeCard(rawCard);

    // Remove any existing copy from every column (guards against a card
    // momentarily appearing in two places during a cross-column move).
    for (const col of this.columns) {
      const idx = col.cards.findIndex((c) => c.id === card.id);
      if (idx !== -1) col.cards.splice(idx, 1);
    }

    const target = this.getColumn(card.column_id);
    if (target) {
      target.cards.push(card);
      target.cards.sort(compareCards);
    }
    this.emit();
  }

  /**
   * Apply a renormalized column payload (array of canonical cards) so the
   * client adopts the server's corrected ordering for that column.
   */
  applyRenormalized(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return;
    const columnId = cards[0].column_id;
    const col = this.getColumn(columnId);
    if (!col) return;
    const ids = new Set(cards.map((c) => c.id));
    // Remove the renormalized cards from anywhere they may exist.
    for (const c of this.columns) {
      c.cards = c.cards.filter((card) => !ids.has(card.id));
    }
    for (const raw of cards) col.cards.push(normalizeCard(raw));
    col.cards.sort(compareCards);
    this.emit();
  }

  /**
   * Optimistically move a card within the local model before the server
   * responds. `beforeId` is the card that should sit immediately below the
   * moved card in the target column (or null for bottom).
   */
  optimisticMove(cardId, targetColumnId, beforeId) {
    const found = this.findCard(cardId);
    if (!found) return;
    const { card } = found;

    // Remove from current location.
    for (const col of this.columns) {
      const idx = col.cards.findIndex((c) => c.id === cardId);
      if (idx !== -1) col.cards.splice(idx, 1);
    }

    const target = this.getColumn(targetColumnId);
    if (!target) return;

    card.column_id = targetColumnId;

    // Compute an interim fractional position between neighbours so the
    // model order matches the desired drop, pending server reconciliation.
    let insertIndex = target.cards.length;
    if (beforeId) {
      const i = target.cards.findIndex((c) => c.id === beforeId);
      if (i !== -1) insertIndex = i;
    }

    const above = target.cards[insertIndex - 1];
    const below = target.cards[insertIndex];
    card.position = interimPosition(above, below);

    target.cards.splice(insertIndex, 0, card);
    this.emit();
  }
}

/** @typedef {{id:string,column_id:string,text:string,position:number,created_at:string}} Card */

function normalizeCard(raw) {
  return {
    id: raw.id,
    column_id: raw.column_id,
    text: raw.text,
    position: Number(raw.position),
    created_at: raw.created_at,
  };
}

function compareCards(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  // Stable tie-break: created_at then id, matching the server's ordering.
  if (a.created_at && b.created_at && a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function interimPosition(above, below) {
  const STEP = 1000;
  if (!above && !below) return STEP;
  if (above && !below) return above.position + STEP;
  if (!above && below) return below.position - STEP;
  return (above.position + below.position) / 2;
}
