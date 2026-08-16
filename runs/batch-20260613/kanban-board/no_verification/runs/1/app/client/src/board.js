/**
 * Board rendering module.
 *
 * Responsible for creating and updating DOM elements for columns and cards.
 * Keeps a registry of column/card DOM elements so we can do targeted updates
 * rather than full re-renders.
 */

import { getColumns, getColumn } from './store.js';
import { makeDraggable, makeDropTarget } from './dragdrop.js';
import { openNewCardDialog } from './dialog.js';

/** @type {HTMLElement} */
let boardEl;

/** columnId → { colEl, listEl, countSpan } */
const columnEls = new Map();

/* ── Bootstrap ──────────────────────────────────────────────────────── */

/**
 * Initial render: build all columns and cards from the store.
 * @param {HTMLElement} container
 */
export function renderBoard(container) {
  boardEl = container;
  boardEl.innerHTML = '';
  columnEls.clear();

  for (const col of getColumns()) {
    const { colEl } = createColumnEl(col);
    boardEl.appendChild(colEl);
  }
}

/* ── Column creation ────────────────────────────────────────────────── */

function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'column-title';
  titleSpan.textContent = col.title;

  const countSpan = document.createElement('span');
  countSpan.className = 'card-count';
  countSpan.textContent = col.cards.length;

  header.appendChild(titleSpan);
  header.appendChild(countSpan);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  makeDropTarget(listEl, col.id);

  // Populate cards + trailing indicator
  populateCardList(listEl, col.cards, col.id);

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.innerHTML = '<span class="icon">＋</span> Add a card';
  addBtn.addEventListener('click', () => openNewCardDialog(col.id));

  colEl.appendChild(header);
  colEl.appendChild(listEl);
  colEl.appendChild(addBtn);

  columnEls.set(col.id, { colEl, listEl, countSpan });

  return { colEl, listEl };
}

/* ── Card element creation ──────────────────────────────────────────── */

/**
 * Create a card DOM element (with its preceding drop indicator).
 * @param {object} card
 * @param {string} columnId
 * @returns {{ indicator: HTMLElement, cardEl: HTMLElement }}
 */
function createCardEl(card, columnId) {
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;

  makeDraggable(cardEl, card.id, columnId);

  return { indicator, cardEl };
}

/**
 * Populate a card-list element with cards and a trailing drop indicator.
 * Each card is preceded by a drop indicator; a final trailing indicator
 * allows dropping after the last card.
 *
 * Layout per card:
 *   [drop-indicator] [card] [drop-indicator] [card] … [drop-indicator]
 *
 * @param {HTMLElement} listEl
 * @param {object[]}    cards
 * @param {string}      columnId
 */
function populateCardList(listEl, cards, columnId) {
  listEl.innerHTML = '';

  for (const card of cards) {
    const { indicator, cardEl } = createCardEl(card, columnId);
    listEl.appendChild(indicator);
    listEl.appendChild(cardEl);
  }

  // Trailing indicator — allows dropping at the very end of the list
  const trailing = document.createElement('div');
  trailing.className = 'drop-indicator';
  listEl.appendChild(trailing);
}

/* ── Targeted re-render ─────────────────────────────────────────────── */

/**
 * Re-render a single column's card list from the store.
 * Preserves the column shell (header, button); only rebuilds the card list.
 *
 * @param {string} columnId
 */
export function renderColumn(columnId) {
  const els = columnEls.get(columnId);
  if (!els) return;

  const col = getColumn(columnId);
  if (!col) return;

  const { listEl, countSpan } = els;

  populateCardList(listEl, col.cards, columnId);

  // Update count badge
  countSpan.textContent = col.cards.length;
}

/**
 * Re-render all columns.
 */
export function renderAllColumns() {
  for (const col of getColumns()) {
    renderColumn(col.id);
  }
}
