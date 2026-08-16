/**
 * DOM rendering module.
 *
 * Provides functions to:
 *   - renderBoard(columns)         – full initial render
 *   - reconcileBoard(columns)      – reconcile DOM to canonical server state
 *   - reconcileColumn(columnId, cards) – reconcile a single column's cards
 *
 * The reconcile functions are called after SSE events to snap the DOM to
 * the server's authoritative ordering without a full re-render.
 */

/* ─── Card element factory ──────────────────────────────────────────────────── */

/**
 * Create a card DOM element.
 * @param {{ id: string, text: string, position: number }} card
 * @returns {HTMLElement}
 */
export function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;
  el.textContent = card.text;
  el.setAttribute('role', 'listitem');
  el.setAttribute('aria-label', card.text);
  return el;
}

/* ─── Column element factory ────────────────────────────────────────────────── */

/**
 * Create a full column DOM element (header + card list + add-card form).
 * @param {{ id: string, title: string, cards: any[] }} column
 * @returns {HTMLElement}
 */
export function createColumnEl(column) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = column.id;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', column.title);

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const title = document.createElement('span');
  title.className = 'column-title';
  title.textContent = column.title;

  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = column.cards.length;

  header.appendChild(title);
  header.appendChild(count);

  // Card list
  const list = document.createElement('div');
  list.className = 'card-list';
  list.setAttribute('role', 'list');
  list.dataset.columnId = column.id;

  for (const card of column.cards) {
    list.appendChild(createCardEl(card));
  }

  // Add-card area
  const addArea = document.createElement('div');
  addArea.className = 'add-card-area';
  addArea.innerHTML = `
    <button class="add-card-btn" aria-label="Add a card to ${column.title}">
      <span class="plus-icon">＋</span>
      <span>Add a card</span>
    </button>
    <div class="add-card-form" role="form" aria-label="New card form">
      <textarea
        class="add-card-textarea"
        placeholder="Enter card text…"
        rows="3"
        maxlength="500"
        aria-label="Card text"
      ></textarea>
      <div class="add-card-actions">
        <button class="btn-primary add-card-submit">Add card</button>
        <button class="btn-cancel add-card-cancel" aria-label="Cancel">✕</button>
      </div>
    </div>
  `;

  el.appendChild(header);
  el.appendChild(list);
  el.appendChild(addArea);

  return el;
}

/* ─── Full board render ─────────────────────────────────────────────────────── */

/**
 * Render the entire board from scratch.
 * @param {HTMLElement} boardEl
 * @param {any[]} columns
 */
export function renderBoard(boardEl, columns) {
  // Reset wiring flags so callers re-attach event listeners after a full render
  boardEl._addCardWired = false;
  boardEl._dragDropWired = false;
  boardEl.innerHTML = '';
  for (const col of columns) {
    boardEl.appendChild(createColumnEl(col));
  }
}

/* ─── Reconciliation ────────────────────────────────────────────────────────── */

/**
 * Reconcile a single column's card list to the canonical server order.
 *
 * Strategy:
 *   1. Build a map of existing card elements by id.
 *   2. Re-order them in the list according to the canonical `cards` array.
 *   3. Remove any card elements not present in the canonical list.
 *   4. Create and insert any new cards not yet in the DOM.
 *
 * This preserves existing DOM nodes (avoids losing drag state on other cards).
 *
 * @param {string}      columnId
 * @param {any[]}       cards     – canonical ordered card list from server
 */
export function reconcileColumn(columnId, cards) {
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const list = colEl.querySelector('.card-list');
  if (!list) return;

  // Build map of existing card elements
  /** @type {Map<string, HTMLElement>} */
  const existing = new Map();
  list.querySelectorAll('.card').forEach((el) => {
    existing.set(el.dataset.cardId, el);
  });

  // Build the desired set of card ids
  const desiredIds = new Set(cards.map((c) => c.id));

  // Remove cards no longer in the canonical list
  for (const [id, el] of existing) {
    if (!desiredIds.has(id)) {
      el.remove();
      existing.delete(id);
    }
  }

  // Re-order / insert cards
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    let el = existing.get(card.id);

    if (!el) {
      // Card not in this column's list – check if it exists elsewhere in the
      // board (cross-column move where source wasn't reconciled yet).
      const boardEl = colEl.closest('#board');
      const elsewhere = boardEl
        ? boardEl.querySelector(`[data-card-id="${card.id}"]`)
        : null;

      if (elsewhere) {
        // Re-use the existing element (moves it out of the old column)
        el = elsewhere;
      } else {
        // Genuinely new card – create it
        el = createCardEl(card);
      }
      existing.set(card.id, el);
    }

    // Update position data attribute
    el.dataset.position = card.position;

    // Ensure the element is at position i in the list
    const currentAtIndex = list.querySelectorAll('.card')[i];
    if (currentAtIndex !== el) {
      list.insertBefore(el, currentAtIndex ?? null);
    }
  }

  // Update count badge
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = cards.length;
}

/**
 * Reconcile the entire board to the canonical server state.
 * Used after a board:state event (e.g. on reconnect).
 *
 * @param {HTMLElement} boardEl
 * @param {any[]}       columns
 */
export function reconcileBoard(boardEl, columns) {
  // Check if we need a full re-render (column set changed)
  const existingColIds = new Set(
    Array.from(boardEl.querySelectorAll('.column')).map((el) => el.dataset.columnId),
  );
  const newColIds = new Set(columns.map((c) => c.id));

  const sameColumns =
    existingColIds.size === newColIds.size &&
    [...existingColIds].every((id) => newColIds.has(id));

  if (!sameColumns) {
    // Column set changed – full re-render; reset wiring flags so
    // event listeners are re-attached by the caller.
    boardEl._addCardWired = false;
    boardEl._dragDropWired = false;
    renderBoard(boardEl, columns);
    return;
  }

  // Same columns – reconcile each column's cards
  for (const col of columns) {
    reconcileColumn(col.id, col.cards);
  }
}
