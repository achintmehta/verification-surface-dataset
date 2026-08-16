/**
 * DOM rendering helpers.
 *
 * render.js is responsible for creating and updating DOM elements.
 * It does NOT own state – callers pass in the current state and the
 * render functions reconcile the DOM to match.
 */

import { makeCardDraggable, makeListDroppable } from './drag.js';

/** @type {HTMLElement} */
let boardEl;

/** @type {(columnId: string) => void} */
let onAddCard;

/**
 * Initialise the renderer.
 * @param {HTMLElement} board
 * @param {Function}    addCardCallback  called with columnId when user clicks "+ Add card"
 */
export function initRenderer(board, addCardCallback) {
  boardEl   = board;
  onAddCard = addCardCallback;
}

/* ------------------------------------------------------------------ */
/*  Full board render (initial load)                                    */
/* ------------------------------------------------------------------ */

/**
 * Render the entire board from scratch.
 * @param {Column[]} columns  sorted by position
 */
export function renderBoard(columns) {
  boardEl.innerHTML = '';
  for (const col of columns) {
    boardEl.appendChild(createColumnEl(col));
  }
}

/* ------------------------------------------------------------------ */
/*  Incremental updates                                                 */
/* ------------------------------------------------------------------ */

/**
 * Re-render a single column's card list to match the given cards array.
 * Preserves the column header and add-card button.
 * @param {string} columnId
 * @param {Card[]} cards  sorted by position
 */
export function renderColumnCards(columnId, cards) {
  const listEl = getListEl(columnId);
  if (!listEl) return;

  // Reconcile: remove cards no longer present, add new ones, reorder
  const existingMap = new Map();
  for (const el of listEl.querySelectorAll('.card[data-card-id]')) {
    existingMap.set(el.dataset.cardId, el);
  }

  // Remove stale cards
  for (const [id, el] of existingMap) {
    if (!cards.find((c) => c.id === id)) el.remove();
  }

  // Insert / reorder
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    let el = existingMap.get(card.id);

    if (!el) {
      el = createCardEl(card);
    } else {
      // Update text in case it changed
      el.querySelector('.card-text').textContent = card.text;
    }

    // Ensure correct position in DOM
    const currentAtIndex = listEl.children[i];
    if (currentAtIndex !== el) {
      listEl.insertBefore(el, currentAtIndex ?? null);
    }
  }

  // Update card count badge
  updateCardCount(columnId, cards.length);
}

/**
 * Add a single card to a column (optimistic or from SSE create event).
 * If the card already exists in any column, move it.
 * @param {Card} card
 * @param {Card[]} columnCards  full sorted card list for the card's column
 */
export function renderUpsertCard(card, columnCards) {
  // Remove from any column it currently lives in
  const existing = boardEl.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  renderColumnCards(card.column_id, columnCards);
}

/* ------------------------------------------------------------------ */
/*  Element factories                                                   */
/* ------------------------------------------------------------------ */

function createColumnEl(col) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span class="column-title">${escHtml(col.title)}</span>
    <span class="column-card-count" data-count="${col.id}">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;
  listEl.setAttribute('role', 'list');

  for (const card of col.cards) {
    listEl.appendChild(createCardEl(card));
  }

  makeListDroppable(listEl, col.id, boardEl);
  colEl.appendChild(listEl);

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.dataset.columnId = col.id;
  addBtn.innerHTML = `<span class="icon">＋</span> Add card`;
  addBtn.addEventListener('click', () => onAddCard(col.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.setAttribute('role', 'listitem');
  el.innerHTML = `
    <div class="card-text">${escHtml(card.text)}</div>
    <div class="card-meta">${formatDate(card.created_at)}</div>
  `;
  makeCardDraggable(el, card.id);
  return el;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function getListEl(columnId) {
  return boardEl.querySelector(`.card-list[data-column-id="${columnId}"]`);
}

function updateCardCount(columnId, count) {
  const badge = boardEl.querySelector(`[data-count="${columnId}"]`);
  if (badge) badge.textContent = count;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
    });
  } catch {
    return '';
  }
}
