/**
 * DOM renderer for the Kanban board.
 *
 * Performs a minimal reconciliation: it diffs the current DOM against
 * the desired state and makes only the necessary changes, so that
 * in-flight drag operations are not disrupted.
 */

import { getColumns } from './store.js';

const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Full render / reconcile pass.
 * Called after every state change (initial load, SSE event, optimistic update).
 *
 * @param {{ onAddCard: (columnId: string) => void }} callbacks
 */
export function render(callbacks) {
  const columns = getColumns();

  // Remove the loading placeholder if present
  const loading = document.getElementById('board-loading');
  if (loading) loading.remove();

  // Build a map of existing column elements
  const existingCols = new Map();
  for (const el of boardEl.querySelectorAll('.column')) {
    existingCols.set(el.dataset.columnId, el);
  }

  // Track which columns are still present
  const seen = new Set();

  columns.forEach((col, colIndex) => {
    seen.add(col.id);
    let colEl = existingCols.get(col.id);

    if (!colEl) {
      colEl = createColumnEl(col, callbacks);
      boardEl.appendChild(colEl);
    } else {
      // Ensure correct DOM order
      const currentIndex = [...boardEl.children].indexOf(colEl);
      if (currentIndex !== colIndex) {
        boardEl.insertBefore(colEl, boardEl.children[colIndex] ?? null);
      }
    }

    reconcileCards(colEl, col.cards);
    updateColumnCount(colEl, col.cards.length);
  });

  // Remove columns that no longer exist
  for (const [id, el] of existingCols) {
    if (!seen.has(id)) el.remove();
  }
}

/* ── Column creation ─────────────────────────────────────────────────────── */

function createColumnEl(col, callbacks) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">0</span>
    </div>
    <div class="card-list" data-column-id="${col.id}"></div>
    <button class="add-card-btn" data-column-id="${col.id}" type="button">
      <span class="icon">＋</span> Add a card
    </button>
  `;

  colEl.querySelector('.add-card-btn').addEventListener('click', () => {
    callbacks.onAddCard(col.id);
  });

  return colEl;
}

function updateColumnCount(colEl, count) {
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = count;
}

/* ── Card reconciliation ─────────────────────────────────────────────────── */

/**
 * Reconcile the card-list DOM for a column against the desired card array.
 * Preserves existing card elements where possible to avoid disrupting
 * any active drag.
 *
 * @param {HTMLElement} colEl
 * @param {object[]}    cards  - sorted by position
 */
function reconcileCards(colEl, cards) {
  const listEl = colEl.querySelector('.card-list');
  if (!listEl) return;

  // Build map of existing card elements
  const existing = new Map();
  for (const el of listEl.querySelectorAll('.card')) {
    existing.set(el.dataset.cardId, el);
  }

  // Remove drop-indicator elements (they are transient)
  for (const ind of listEl.querySelectorAll('.drop-indicator')) ind.remove();

  const seen = new Set();

  cards.forEach((card, idx) => {
    seen.add(card.id);
    let cardEl = existing.get(card.id);

    if (!cardEl) {
      cardEl = createCardEl(card);
    } else {
      // Update text if it changed
      const textEl = cardEl.querySelector('.card-text');
      if (textEl && textEl.textContent !== card.text) {
        textEl.textContent = card.text;
      }
    }

    // Ensure correct position in DOM
    const desired = listEl.children[idx];
    if (desired !== cardEl) {
      listEl.insertBefore(cardEl, desired ?? null);
    }
  });

  // Remove cards that no longer belong here
  for (const [id, el] of existing) {
    if (!seen.has(id)) el.remove();
  }
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;

  const textEl = document.createElement('span');
  textEl.className = 'card-text';
  textEl.textContent = card.text;
  el.appendChild(textEl);

  return el;
}

/* ── Utility ─────────────────────────────────────────────────────────────── */

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
