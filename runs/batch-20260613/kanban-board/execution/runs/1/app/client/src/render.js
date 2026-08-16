/**
 * DOM rendering module for the Kanban board.
 *
 * Provides functions to:
 *  - Render the full board from state
 *  - Reconcile individual card changes without full re-renders
 *  - Manage add-card forms
 */

import { makeCardDraggable, makeListDroppable } from './dragdrop.js';

/** Callback set by main.js for drop events */
let dropHandler = null;
/** Callback set by main.js for card creation */
let createHandler = null;

export function setDropHandler(fn) { dropHandler = fn; }
export function setCreateHandler(fn) { createHandler = fn; }

/* ── Full board render ───────────────────────────────────── */

/**
 * Render the entire board from the state object.
 * Replaces the board element's content.
 *
 * @param {{ columns: Array }} state
 * @param {HTMLElement} boardEl
 */
export function renderBoard(state, boardEl) {
  boardEl.innerHTML = '';

  for (const col of state.columns) {
    const colEl = createColumnEl(col);
    boardEl.appendChild(colEl);
  }
}

/* ── Incremental reconciliation ──────────────────────────── */

/**
 * Reconcile a single card update into the DOM.
 * Ensures the card appears in exactly one column at the correct position.
 *
 * @param {object} card  - canonical card from server
 */
export function reconcileCard(card) {
  // Remove the card from wherever it currently lives in the DOM
  const existing = document.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // Find the target column's card list
  const listEl = document.querySelector(
    `.card-list[data-column-id="${card.column_id}"]`
  );
  if (!listEl) return;

  // Create the card element
  const cardEl = createCardEl(card);

  // Insert it at the correct sorted position
  insertCardIntoList(listEl, cardEl, card.position);

  // Update the card count badge
  updateCardCount(card.column_id);
}

/**
 * Reconcile a full column replacement (after renormalization).
 *
 * @param {string}   columnId
 * @param {object[]} cards     - sorted canonical cards
 */
export function reconcileColumn(columnId, cards) {
  const listEl = document.querySelector(
    `.card-list[data-column-id="${columnId}"]`
  );
  if (!listEl) return;

  // Remove all existing card elements from this list
  listEl.querySelectorAll('.card').forEach((el) => el.remove());

  // Re-insert in canonical order
  for (const card of cards) {
    const cardEl = createCardEl(card);
    listEl.appendChild(cardEl);
  }

  updateCardCount(columnId);
}

/* ── Element factories ───────────────────────────────────── */

function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span class="column-title">${escapeHtml(col.title)}</span>
    <span class="card-count" data-count-for="${col.id}">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(createCardEl(card));
  }

  makeListDroppable(listEl, col.id);
  colEl.appendChild(listEl);

  // Add-card area
  colEl.appendChild(createAddCardArea(col.id));

  return colEl;
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;
  el.textContent = card.text;

  if (card._optimistic) el.classList.add('optimistic');

  makeCardDraggable(el, card.id, (dropInfo) => {
    if (dropHandler) dropHandler(dropInfo);
  });

  return el;
}

function createAddCardArea(columnId) {
  const area = document.createElement('div');
  area.className = 'add-card-area';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = 'Add a card';
  btn.dataset.columnId = columnId;

  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.dataset.columnId = columnId;

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text…';
  textarea.rows = 3;

  const actions = document.createElement('div');
  actions.className = 'add-card-form-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-add-confirm';
  confirmBtn.textContent = 'Add card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-add-cancel';
  cancelBtn.title = 'Cancel';
  cancelBtn.textContent = '✕';

  actions.appendChild(confirmBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  area.appendChild(btn);
  area.appendChild(form);

  // Show form
  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    form.classList.add('visible');
    textarea.focus();
  });

  // Hide form
  function hideForm() {
    form.classList.remove('visible');
    btn.style.display = '';
    textarea.value = '';
  }

  cancelBtn.addEventListener('click', hideForm);

  // Submit
  async function submitCard() {
    const text = textarea.value.trim();
    if (!text) return;
    hideForm();
    if (createHandler) createHandler(columnId, text);
  }

  confirmBtn.addEventListener('click', submitCard);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === 'Escape') hideForm();
  });

  return area;
}

/* ── Helpers ─────────────────────────────────────────────── */

/**
 * Insert a card element into a list at the correct sorted position
 * (by data-position attribute).
 */
function insertCardIntoList(listEl, cardEl, position) {
  const cards = [...listEl.querySelectorAll('.card')];
  let inserted = false;

  for (const existing of cards) {
    const existingPos = parseFloat(existing.dataset.position);
    if (position < existingPos) {
      listEl.insertBefore(cardEl, existing);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    // Append before the add-card area (which is not inside the list)
    listEl.appendChild(cardEl);
  }
}

function updateCardCount(columnId) {
  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  const badge = document.querySelector(`[data-count-for="${columnId}"]`);
  if (listEl && badge) {
    badge.textContent = listEl.querySelectorAll('.card').length;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
