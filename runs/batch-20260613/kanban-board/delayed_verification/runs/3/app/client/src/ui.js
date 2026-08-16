/**
 * UI rendering module.
 *
 * Responsible for:
 *  - Rendering the full board from state
 *  - Incrementally updating individual cards / columns
 *  - Managing the "Add Card" modal
 *
 * The module does NOT own state – it reads from the state module and
 * calls back into main.js for mutations.
 */

import { getState } from './state.js';

let boardEl = null;
let onAddCard = null; // callback(columnId, text)

/* ------------------------------------------------------------------ */
/*  Initialise                                                          */
/* ------------------------------------------------------------------ */

export function initUI(board, addCardCallback) {
  boardEl = board;
  onAddCard = addCardCallback;
  initModal();
}

/* ------------------------------------------------------------------ */
/*  Full board render                                                   */
/* ------------------------------------------------------------------ */

export function renderBoard() {
  const { columns, columnOrder } = getState();
  boardEl.innerHTML = '';

  for (const colId of columnOrder) {
    const col = columns.get(colId);
    if (col) boardEl.appendChild(createColumnEl(col));
  }
}

/* ------------------------------------------------------------------ */
/*  Column element factory                                              */
/* ------------------------------------------------------------------ */

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
  count.textContent = col.cards.length;

  header.appendChild(title);
  header.appendChild(count);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(createCardEl(card));
  }

  // Add card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.dataset.columnId = col.id;
  addBtn.innerHTML = '<span class="plus-icon">\uFF0B</span> Add a card';
  addBtn.addEventListener('click', () => openModal(col.id));

  colEl.appendChild(header);
  colEl.appendChild(listEl);
  colEl.appendChild(addBtn);

  return colEl;
}

/* ------------------------------------------------------------------ */
/*  Card element factory                                                */
/* ------------------------------------------------------------------ */

export function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;
  el.dataset.position = card.position;
  el.textContent = card.text;
  return el;
}

/* ------------------------------------------------------------------ */
/*  Incremental DOM updates                                             */
/* ------------------------------------------------------------------ */

/**
 * Reconcile a single card's position in the DOM to match canonical state.
 * Ensures the card exists in exactly one column.
 *
 * @param {object}  card            - canonical card from server
 * @param {boolean} positionChanged - whether the position differs from optimistic
 */
export function reconcileCardDOM(card, positionChanged) {
  // Track which column the card was in before removal (for count update)
  const existingEl = document.querySelector(`[data-card-id="${card.id}"]`);
  const prevColumnId = existingEl
    ? existingEl.closest('.card-list')?.dataset.columnId
    : null;

  // Remove any existing DOM element for this card
  existingEl?.remove();

  // Find the target column's card list
  const listEl = document.querySelector(
    `.card-list[data-column-id="${card.column_id}"]`
  );
  if (!listEl) return;

  // Build the new element
  const cardEl = createCardEl(card);

  // Insert at the correct sorted position
  insertCardIntoList(listEl, cardEl, card);

  // Flash animation if the server corrected our optimistic guess
  if (positionChanged) {
    cardEl.classList.add('reconciled');
    cardEl.addEventListener(
      'animationend',
      () => cardEl.classList.remove('reconciled'),
      { once: true }
    );
  }

  // Update column card counts (both source and target)
  if (prevColumnId && prevColumnId !== card.column_id) {
    updateColumnCount(prevColumnId);
  }
  updateColumnCount(card.column_id);
}

/**
 * Re-render an entire column's card list (used after renormalisation or
 * optimistic reorder).
 *
 * @param {string}   columnId
 * @param {object[]} cards     - ordered card list
 */
export function reorderColumnDOM(columnId, cards) {
  const listEl = document.querySelector(
    `.card-list[data-column-id="${columnId}"]`
  );
  if (!listEl) return;

  // Remove all existing card elements (not ghost)
  listEl.querySelectorAll('.card:not(.card-ghost)').forEach((el) => el.remove());

  // Re-insert in order
  for (const card of cards) {
    listEl.appendChild(createCardEl(card));
  }

  updateColumnCount(columnId);
}

/**
 * Add a brand-new card to the DOM (from card:created SSE event or optimistic).
 * Idempotent: removes any existing element with the same id first.
 *
 * @param {object} card
 */
export function addCardToDOM(card) {
  // Remove any duplicate first
  document.querySelector(`[data-card-id="${card.id}"]`)?.remove();

  const listEl = document.querySelector(
    `.card-list[data-column-id="${card.column_id}"]`
  );
  if (!listEl) return;

  const cardEl = createCardEl(card);
  insertCardIntoList(listEl, cardEl, card);
  updateColumnCount(card.column_id);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert a card element into a list in position-sorted order.
 */
function insertCardIntoList(listEl, cardEl, card) {
  const position = parseFloat(card.position);
  const siblings = [
    ...listEl.querySelectorAll('.card:not(.card-ghost)'),
  ];

  let inserted = false;
  for (const sibling of siblings) {
    const sibPos = parseFloat(sibling.dataset.position ?? Infinity);
    if (position < sibPos) {
      listEl.insertBefore(cardEl, sibling);
      inserted = true;
      break;
    }
  }
  if (!inserted) listEl.appendChild(cardEl);
}

/**
 * Update the card count badge in a column header.
 */
function updateColumnCount(columnId) {
  const colEl = document.querySelector(
    `.column[data-column-id="${columnId}"]`
  );
  if (!colEl) return;

  const count = colEl.querySelectorAll(
    '.card-list .card:not(.card-ghost)'
  ).length;
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = count;
}

/**
 * Update all column count badges.
 */
export function updateAllColumnCounts() {
  document.querySelectorAll('.column').forEach((colEl) => {
    updateColumnCount(colEl.dataset.columnId);
  });
}

/* ------------------------------------------------------------------ */
/*  Connection status indicator                                         */
/* ------------------------------------------------------------------ */

export function setConnectionStatus(status) {
  const dot = document.getElementById('connection-status');
  if (!dot) return;
  dot.className = `status-dot ${status}`;
  dot.title = `SSE: ${status}`;
}

/* ------------------------------------------------------------------ */
/*  Modal                                                               */
/* ------------------------------------------------------------------ */

let activeColumnId = null;

function initModal() {
  const overlay = document.getElementById('modal-overlay');
  const cancelBtn = document.getElementById('modal-cancel');
  const submitBtn = document.getElementById('modal-submit');
  const textarea = document.getElementById('card-text-input');

  cancelBtn.addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCard();
  });

  submitBtn.addEventListener('click', submitCard);

  async function submitCard() {
    const text = textarea.value.trim();
    if (!text || !activeColumnId) return;

    submitBtn.disabled = true;
    try {
      await onAddCard(activeColumnId, text);
      closeModal();
    } catch (err) {
      console.error('[modal] Failed to create card:', err);
      submitBtn.disabled = false;
    }
  }
}

function openModal(columnId) {
  activeColumnId = columnId;
  const overlay = document.getElementById('modal-overlay');
  const textarea = document.getElementById('card-text-input');
  const submitBtn = document.getElementById('modal-submit');

  textarea.value = '';
  submitBtn.disabled = false;
  overlay.classList.remove('hidden');
  textarea.focus();
}

function closeModal() {
  activeColumnId = null;
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('card-text-input').value = '';
}
