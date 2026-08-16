/**
 * Board rendering module.
 *
 * Responsible for creating and updating the DOM to reflect the current
 * board state.  Exposes:
 *
 *  - renderBoard(state)   – full initial render
 *  - reconcileCard(card)  – move/update a single card in the DOM
 *  - reconcileColumn(col) – re-sort a column's cards in the DOM
 *  - addCardToDOM(card)   – insert a new card element
 *  - removeCardFromDOM(id)– remove a card element
 */

import { getState } from './state.js';

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/** @param {string} id */
export function getCardEl(id) {
  return document.querySelector(`.card[data-id="${id}"]`);
}

/** @param {string} id */
export function getCardListEl(columnId) {
  return document.querySelector(`.card-list[data-column-id="${columnId}"]`);
}

/** @param {string} id */
export function getColumnEl(columnId) {
  return document.querySelector(`.column[data-column-id="${columnId}"]`);
}

/* ------------------------------------------------------------------ */
/*  Card element factory                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a card DOM element.
 * @param {{ id: string, text: string, position: number }} card
 * @returns {HTMLElement}
 */
export function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.setAttribute('draggable', 'true');
  el.dataset.id = card.id;
  el.dataset.position = String(card.position);
  el.textContent = card.text;
  return el;
}

/* ------------------------------------------------------------------ */
/*  Full board render                                                   */
/* ------------------------------------------------------------------ */

/**
 * Render the entire board from scratch.
 * Clears the board container and rebuilds all columns and cards.
 */
export function renderBoard() {
  const { columns } = getState();
  const board = document.getElementById('board');

  // Remove loading indicator.
  const loading = document.getElementById('board-loading');
  if (loading) loading.remove();

  // Remove any previously rendered columns.
  board.querySelectorAll('.column').forEach((el) => el.remove());

  for (const col of columns) {
    board.appendChild(createColumnEl(col));
  }
}

/* ------------------------------------------------------------------ */
/*  Column element factory                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {{ id: string, title: string, cards: Array }} col
 * @returns {HTMLElement}
 */
function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const title = document.createElement('span');
  title.className = 'column-title';
  title.textContent = col.title;

  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = String(col.cards.length);

  header.appendChild(title);
  header.appendChild(count);

  // Card list
  const list = document.createElement('div');
  list.className = 'card-list';
  list.dataset.columnId = col.id;

  for (const card of col.cards) {
    list.appendChild(createCardEl(card));
  }

  // Add-card area
  const addArea = createAddCardArea(col.id);

  colEl.appendChild(header);
  colEl.appendChild(list);
  colEl.appendChild(addArea);

  return colEl;
}

/* ------------------------------------------------------------------ */
/*  Add-card form                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {string} columnId
 * @returns {HTMLElement}
 */
function createAddCardArea(columnId) {
  const area = document.createElement('div');
  area.className = 'add-card-area';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.dataset.columnId = columnId;
  btn.innerHTML = '<span class="icon">＋</span> Add a card';

  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.dataset.columnId = columnId;

  const textarea = document.createElement('textarea');
  textarea.className = 'add-card-textarea';
  textarea.placeholder = 'Enter card text…';
  textarea.rows = 3;

  const actions = document.createElement('div');
  actions.className = 'add-card-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn-primary';
  submitBtn.textContent = 'Add card';
  submitBtn.type = 'button';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.textContent = '✕';
  cancelBtn.type = 'button';
  cancelBtn.title = 'Cancel';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  area.appendChild(btn);
  area.appendChild(form);

  return area;
}

/* ------------------------------------------------------------------ */
/*  Incremental DOM updates                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert a new card into the correct column at the correct position.
 * @param {{ id: string, column_id: string, text: string, position: number }} card
 */
export function addCardToDOM(card) {
  const list = getCardListEl(card.column_id);
  if (!list) return;

  // Remove any existing element with the same id (idempotent).
  const existing = getCardEl(card.id);
  if (existing) existing.remove();

  const el = createCardEl(card);

  // Insert before the first card whose position is greater.
  const siblings = Array.from(list.querySelectorAll('.card'));
  const after = siblings.find(
    (s) => parseFloat(s.dataset.position) > card.position
  );

  if (after) {
    list.insertBefore(el, after);
  } else {
    list.appendChild(el);
  }

  updateColumnCount(card.column_id);
}

/**
 * Remove a card element from the DOM.
 * @param {string} cardId
 */
export function removeCardFromDOM(cardId) {
  const el = getCardEl(cardId);
  if (!el) return;
  const list = el.closest('.card-list');
  el.remove();
  if (list) updateColumnCount(list.dataset.columnId);
}

/**
 * Reconcile a single card: move it to the correct column and position.
 * Used after a `card:moved` or `card:created` SSE event.
 *
 * @param {{ id: string, column_id: string, text: string, position: number }} card
 * @param {string} [sourceColumnId]
 */
export function reconcileCard(card, sourceColumnId) {
  // Remove from wherever it currently lives in the DOM.
  const existing = getCardEl(card.id);
  if (existing) {
    const oldList = existing.closest('.card-list');
    existing.remove();
    if (oldList && oldList.dataset.columnId !== card.column_id) {
      updateColumnCount(oldList.dataset.columnId);
    }
  }

  // Insert at canonical position.
  addCardToDOM(card);
}

/**
 * Re-sort all cards in a column according to the state store.
 * Used after a `renorm` event.
 *
 * @param {string} columnId
 */
export function reconcileColumn(columnId) {
  const { columns } = getState();
  const col = columns.find((c) => c.id === columnId);
  if (!col) return;

  const list = getCardListEl(columnId);
  if (!list) return;

  // Re-insert all cards in the correct order.
  for (const card of col.cards) {
    const el = getCardEl(card.id);
    if (el) {
      el.dataset.position = String(card.position);
      list.appendChild(el); // move to end; we'll sort below
    }
  }

  // Sort DOM nodes by position.
  const cards = Array.from(list.querySelectorAll('.card'));
  cards.sort((a, b) => parseFloat(a.dataset.position) - parseFloat(b.dataset.position));
  for (const card of cards) {
    list.appendChild(card);
  }

  updateColumnCount(columnId);
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */

/**
 * Update the card-count badge in a column header.
 * @param {string} columnId
 */
export function updateColumnCount(columnId) {
  const list = getCardListEl(columnId);
  if (!list) return;
  const count = list.querySelectorAll('.card').length;
  const colEl = getColumnEl(columnId);
  if (!colEl) return;
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = String(count);
}
