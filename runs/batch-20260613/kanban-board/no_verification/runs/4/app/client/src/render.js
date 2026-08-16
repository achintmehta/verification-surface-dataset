/**
 * DOM rendering for the Kanban board.
 *
 * All rendering is done by diffing the current store state against the
 * live DOM.  We avoid full re-renders to preserve drag state and
 * prevent flicker.
 */

import { getColumns } from './store.js';
import { makeDraggable, makeDropTarget } from './dragdrop.js';
import { createCard as apiCreateCard } from './api.js';

const boardEl = () => document.getElementById('board');

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Full render / reconcile of the board DOM against the current store.
 * Safe to call at any time; it is idempotent.
 */
export function renderBoard() {
  const board = boardEl();
  const columns = getColumns();

  // Remove the loading placeholder if present.
  const loading = board.querySelector('.board-loading');
  if (loading) loading.remove();

  // Reconcile columns.
  const existingColEls = new Map(
    [...board.querySelectorAll('.column')].map((el) => [
      el.dataset.columnId,
      el,
    ])
  );

  const orderedIds = columns.map((c) => c.id);

  // Remove columns that no longer exist.
  for (const [id, el] of existingColEls) {
    if (!orderedIds.includes(id)) el.remove();
  }

  // Insert / update columns in order.
  columns.forEach((col, colIndex) => {
    let colEl = existingColEls.get(col.id);

    if (!colEl) {
      colEl = createColumnEl(col);
      board.appendChild(colEl);
    }

    // Ensure correct DOM order.
    const currentChildren = [...board.querySelectorAll('.column')];
    if (currentChildren.indexOf(colEl) !== colIndex) {
      board.insertBefore(colEl, currentChildren[colIndex] ?? null);
    }

    reconcileCards(colEl, col);
    updateColumnCount(colEl, col.cards.length);
  });
}

/* ------------------------------------------------------------------ */
/*  Column creation                                                     */
/* ------------------------------------------------------------------ */

function createColumnEl(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = col.id;

  el.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">0</span>
    </div>
    <div class="card-list" role="list"></div>
    <div class="add-card-area"></div>
  `;

  const listEl = el.querySelector('.card-list');
  makeDropTarget(listEl, col.id);

  const addArea = el.querySelector('.add-card-area');
  renderAddCardUI(addArea, col.id);

  return el;
}

function updateColumnCount(colEl, count) {
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = count;
}

/* ------------------------------------------------------------------ */
/*  Card reconciliation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Reconcile the card list DOM for a single column.
 *
 * Strategy:
 *  1. Build a map of existing card elements by id.
 *  2. For each card in the store (already sorted by position), ensure
 *     a DOM element exists and is in the correct position.
 *  3. Remove any card elements that are no longer in the store.
 */
function reconcileCards(colEl, col) {
  const listEl = colEl.querySelector('.card-list');
  const cards = col.cards; // already sorted by position

  const existingCardEls = new Map(
    [...listEl.querySelectorAll('.card')].map((el) => [
      el.dataset.cardId,
      el,
    ])
  );

  const orderedCardIds = cards.map((c) => c.id);

  // Remove cards that are no longer in this column.
  for (const [id, el] of existingCardEls) {
    if (!orderedCardIds.includes(id)) el.remove();
  }

  // Insert / reorder cards.
  cards.forEach((card, cardIndex) => {
    let cardEl = existingCardEls.get(card.id);

    if (!cardEl) {
      cardEl = createCardEl(card);
    } else {
      // Update text in case it changed.
      const textEl = cardEl.querySelector('.card-text');
      if (textEl && textEl.textContent !== card.text) {
        textEl.textContent = card.text;
      }
    }

    // Ensure correct DOM order within the list.
    const currentCards = [...listEl.querySelectorAll('.card')];
    if (currentCards.indexOf(cardEl) !== cardIndex) {
      const refEl = currentCards[cardIndex] ?? null;
      listEl.insertBefore(cardEl, refEl);
    } else if (!listEl.contains(cardEl)) {
      listEl.appendChild(cardEl);
    }
  });
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.setAttribute('role', 'listitem');
  el.dataset.cardId = card.id;

  el.innerHTML = `<span class="card-text">${escHtml(card.text)}</span>`;

  makeDraggable(el, card.id);
  return el;
}

/* ------------------------------------------------------------------ */
/*  Add-card UI                                                         */
/* ------------------------------------------------------------------ */

function renderAddCardUI(container, columnId) {
  container.innerHTML = '';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.innerHTML = `<span class="icon">＋</span> Add a card`;
  btn.addEventListener('click', () => showAddCardForm(container, columnId));

  container.appendChild(btn);
}

function showAddCardForm(container, columnId) {
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.rows = 3;
  textarea.placeholder = 'Enter card text…';
  textarea.autofocus = true;

  const actions = document.createElement('div');
  actions.className = 'add-card-form-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary';
  addBtn.textContent = 'Add card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.textContent = '✕';
  cancelBtn.title = 'Cancel';

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);
  container.appendChild(form);

  textarea.focus();

  const cancel = () => renderAddCardUI(container, columnId);

  cancelBtn.addEventListener('click', cancel);

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;

    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';

    try {
      await apiCreateCard(columnId, text);
      // The SSE event will update the board; just reset the form.
      renderAddCardUI(container, columnId);
    } catch (err) {
      console.error('[render] createCard failed:', err);
      addBtn.disabled = false;
      addBtn.textContent = 'Add card';
      textarea.focus();
    }
  };

  addBtn.addEventListener('click', submit);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') cancel();
  });
}

/* ------------------------------------------------------------------ */
/*  Utility                                                             */
/* ------------------------------------------------------------------ */

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
