/**
 * DOM rendering module.
 *
 * Provides functions to render the full board and to reconcile individual
 * column card lists against the canonical state without full re-renders.
 */

import { getColumns } from './state.js';

const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));
const loadingEl = document.getElementById('board-loading');

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Render the full board from state. Called once on initial load.
 * Subsequent updates use reconcileColumn().
 */
export function renderBoard() {
  if (loadingEl) loadingEl.remove();

  const columns = getColumns();

  // Remove any existing column elements
  boardEl.querySelectorAll('.column').forEach((el) => el.remove());

  for (const col of columns) {
    boardEl.appendChild(createColumnEl(col));
  }
}

/**
 * Reconcile a single column's card list against the current state.
 * Preserves the dragging card's DOM element to avoid interrupting an
 * in-progress drag.
 *
 * @param {string} columnId
 * @param {string|null} draggingCardId - id of the card currently being dragged (skip re-render)
 */
export function reconcileColumn(columnId, draggingCardId = null) {
  const columns = getColumns();
  const col = columns.find((c) => c.id === columnId);
  if (!col) return;

  const colEl = boardEl.querySelector(`[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const listEl = colEl.querySelector('.card-list');
  if (!listEl) return;

  // Update card count badge
  const countEl = colEl.querySelector('.column-count');
  if (countEl) countEl.textContent = col.cards.length;

  // Build a map of existing card DOM elements
  /** @type {Map<string, HTMLElement>} */
  const existingEls = new Map();
  listEl.querySelectorAll('.card[data-card-id]').forEach((el) => {
    existingEls.set(el.dataset.cardId, /** @type {HTMLElement} */ (el));
  });

  // Remove placeholder if present
  listEl.querySelectorAll('.card-placeholder').forEach((el) => el.remove());

  // Rebuild the list in order
  const fragment = document.createDocumentFragment();
  for (const card of col.cards) {
    if (card.id === draggingCardId) {
      // Keep the existing element (it has the .dragging class)
      const existing = existingEls.get(card.id);
      if (existing) {
        fragment.appendChild(existing);
        existingEls.delete(card.id);
        continue;
      }
    }

    let cardEl = existingEls.get(card.id);
    if (cardEl) {
      // Update text in case it changed
      const textEl = cardEl.querySelector('.card-text');
      if (textEl) textEl.textContent = card.text;
      existingEls.delete(card.id);
    } else {
      cardEl = createCardEl(card);
    }
    fragment.appendChild(cardEl);
  }

  // Remove stale card elements (card moved to another column)
  for (const staleEl of existingEls.values()) {
    staleEl.remove();
  }

  listEl.appendChild(fragment);
}

/**
 * Reconcile all columns.
 * @param {string|null} draggingCardId
 */
export function reconcileAllColumns(draggingCardId = null) {
  const columns = getColumns();
  for (const col of columns) {
    reconcileColumn(col.id, draggingCardId);
  }
}

/* ------------------------------------------------------------------ */
/* Element factories                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {{id:string, title:string, cards:Array}} col
 * @returns {HTMLElement}
 */
function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">${col.cards.length}</span>
    </div>
    <div class="card-list" data-column-id="${col.id}"></div>
    <button class="add-card-btn" data-column-id="${col.id}" aria-label="Add card to ${escHtml(col.title)}">
      <span class="icon">＋</span> Add a card
    </button>
  `;

  const listEl = colEl.querySelector('.card-list');
  for (const card of col.cards) {
    listEl.appendChild(createCardEl(card));
  }

  return colEl;
}

/**
 * @param {{id:string, text:string}} card
 * @returns {HTMLElement}
 */
export function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.innerHTML = `<span class="card-text">${escHtml(card.text)}</span>`;
  return el;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
