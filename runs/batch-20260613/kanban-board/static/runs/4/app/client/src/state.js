/**
 * Client-side board state store.
 *
 * Holds the canonical board state as received from the server.
 * Provides helpers to apply server events (create, move, reorder).
 *
 * State shape:
 * {
 *   columns: [
 *     { id, title, position, cards: [{ id, column_id, text, position, created_at }, ...] }
 *   ]
 * }
 *
 * All mutations return a new state object (immutable-style) so callers can
 * diff and re-render only what changed.
 */

/** @type {{ columns: Array<{ id: string, title: string, position: number, cards: Array<{ id: string, column_id: string, text: string, position: number, created_at: string }> }> }} */
let _state = { columns: [] };

/** Return the current state (read-only reference). */
export function getState() {
  return _state;
}

/**
 * Replace the entire board state (used on initial load / board:state event).
 * @param {{ columns: any[] }} boardData
 */
export function setBoardState(boardData) {
  _state = {
    columns: boardData.columns.map(normalizeColumn),
  };
}

/**
 * Apply a card:created event.
 * Adds the card to the correct column, maintaining position order.
 * @param {{ card: any }} payload
 */
export function applyCardCreated(payload) {
  const card = normalizeCard(payload.card);
  _state = {
    columns: _state.columns.map((col) => {
      if (col.id !== card.column_id) return col;
      // Remove any existing card with the same id (shouldn't happen, but be safe)
      const filtered = col.cards.filter((c) => c.id !== card.id);
      const cards = insertCardSorted(filtered, card);
      return { ...col, cards };
    }),
  };
}

/**
 * Apply a card:moved event.
 * Removes the card from its old column (if different) and inserts it
 * into the target column at the correct position.
 * Guarantees the card exists in exactly one column.
 * @param {{ card: any }} payload
 */
export function applyCardMoved(payload) {
  const card = normalizeCard(payload.card);
  _state = {
    columns: _state.columns.map((col) => {
      if (col.id === card.column_id) {
        // Target column: remove stale copy (if any) and insert at canonical position
        const filtered = col.cards.filter((c) => c.id !== card.id);
        const cards = insertCardSorted(filtered, card);
        return { ...col, cards };
      } else {
        // Any other column: remove the card (handles cross-column moves)
        const cards = col.cards.filter((c) => c.id !== card.id);
        return { ...col, cards };
      }
    }),
  };
}

/**
 * Apply a column:reordered event (after server renormalisation).
 * Replaces the cards array for the affected column with the canonical list.
 * @param {{ columnId: string, cards: any[] }} payload
 */
export function applyColumnReordered(payload) {
  const { columnId, cards: rawCards } = payload;
  const cards = rawCards.map(normalizeCard);
  _state = {
    columns: _state.columns.map((col) => {
      if (col.id !== columnId) return col;
      return { ...col, cards };
    }),
  };
}

/* ─── Internal helpers ──────────────────────────────────────────────────────── */

function normalizeColumn(col) {
  return {
    id: col.id,
    title: col.title,
    position: Number(col.position),
    cards: (col.cards ?? []).map(normalizeCard),
  };
}

function normalizeCard(card) {
  return {
    id: card.id,
    column_id: card.column_id,
    text: card.text,
    position: Number(card.position),
    created_at: card.created_at,
  };
}

/**
 * Insert `card` into `cards` maintaining ascending position order.
 * @param {any[]} cards
 * @param {any}   card
 * @returns {any[]}
 */
function insertCardSorted(cards, card) {
  const result = [...cards];
  let i = result.findIndex((c) => c.position > card.position);
  if (i === -1) {
    result.push(card);
  } else {
    result.splice(i, 0, card);
  }
  return result;
}
