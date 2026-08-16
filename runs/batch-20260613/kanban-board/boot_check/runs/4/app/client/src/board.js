/**
 * DOM rendering for the Kanban board.
 *
 * Rendering strategy:
 *  - renderBoard()  – full re-render from state (used on initial load)
 *  - renderColumn() – re-render a single column's card list (used after mutations)
 *  - reconcileCard()– move/update a single card element in the DOM
 */

import { getState, findColumn, findCard } from './state.js';

const boardEl = () => document.getElementById('board');

/* ------------------------------------------------------------------ */
/*  Full board render                                                   */
/* ------------------------------------------------------------------ */
export function renderBoard() {
  const board = boardEl();
  board.innerHTML = '';

  const { columns } = getState();
  for (const col of columns) {
    board.appendChild(buildColumnEl(col));
  }
}

/* ------------------------------------------------------------------ */
/*  Column element builder                                              */
/* ------------------------------------------------------------------ */
function buildColumnEl(col) {
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
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(buildCardEl(card));
  }
  colEl.appendChild(listEl);

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.dataset.columnId = col.id;
  addBtn.innerHTML = '<span class="icon">＋</span> Add card';
  colEl.appendChild(addBtn);

  return colEl;
}

/* ------------------------------------------------------------------ */
/*  Card element builder                                                */
/* ------------------------------------------------------------------ */
export function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;
  el.textContent = card.text;
  return el;
}

/* ------------------------------------------------------------------ */
/*  Re-render a single column's card list                              */
/* ------------------------------------------------------------------ */
export function renderColumnCards(columnId) {
  const col = findColumn(columnId);
  if (!col) return;

  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  // Rebuild card list preserving the dragging card's .dragging class
  const draggingId = document.querySelector('.card.dragging')?.dataset.cardId;

  listEl.innerHTML = '';
  for (const card of col.cards) {
    const el = buildCardEl(card);
    if (card.id === draggingId) el.classList.add('dragging');
    listEl.appendChild(el);
  }

  // Update count badge
  const countEl = listEl.closest('.column')?.querySelector('.column-count');
  if (countEl) countEl.textContent = col.cards.length;
}

/* ------------------------------------------------------------------ */
/*  Reconcile a single card after a server event                       */
/* ------------------------------------------------------------------ */
export function reconcileCard(serverCard) {
  // Remove the card from wherever it currently is in the DOM
  const existing = document.querySelector(`.card[data-card-id="${serverCard.id}"]`);
  if (existing) existing.remove();

  // Re-render the affected columns
  const col = findColumn(serverCard.column_id);
  if (!col) return;

  renderColumnCards(serverCard.column_id);

  // If the card moved from another column, update that column too
  // (state has already been updated before this is called)
}

/* ------------------------------------------------------------------ */
/*  Update column card counts                                           */
/* ------------------------------------------------------------------ */
export function updateColumnCount(columnId) {
  const col = findColumn(columnId);
  if (!col) return;
  const countEl = document.querySelector(
    `.column[data-column-id="${columnId}"] .column-count`
  );
  if (countEl) countEl.textContent = col.cards.length;
}
