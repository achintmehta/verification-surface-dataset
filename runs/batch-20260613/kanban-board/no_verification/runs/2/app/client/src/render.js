/**
 * DOM rendering module.
 *
 * Provides functions to:
 *  - render the full board from state
 *  - update a single card (upsert / move)
 *  - reorder an entire column
 *
 * All mutations go through these functions so the DOM stays in sync
 * with the state module.
 */

import { getColumns, getColumn } from './state.js';

/* ------------------------------------------------------------------ */
/*  Board container reference                                           */
/* ------------------------------------------------------------------ */

let boardEl = null;

export function setBoardEl(el) {
  boardEl = el;
}

/* ------------------------------------------------------------------ */
/*  Full board render                                                   */
/* ------------------------------------------------------------------ */

export function renderBoard(onAddCard) {
  boardEl.innerHTML = '';
  for (const col of getColumns()) {
    boardEl.appendChild(buildColumnEl(col, onAddCard));
  }
}

/* ------------------------------------------------------------------ */
/*  Column builder                                                      */
/* ------------------------------------------------------------------ */

function buildColumnEl(col, onAddCard) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span class="column-title">${escHtml(col.title)}</span>
    <span class="card-count">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const list = document.createElement('div');
  list.className = 'card-list';
  list.dataset.columnId = col.id;
  for (const card of col.cards) {
    list.appendChild(buildCardEl(card));
  }
  colEl.appendChild(list);

  // Add-card area
  colEl.appendChild(buildAddCardArea(col.id, onAddCard));

  return colEl;
}

/* ------------------------------------------------------------------ */
/*  Card builder                                                        */
/* ------------------------------------------------------------------ */

function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;
  el.textContent = card.text;
  if (card._optimistic) el.dataset.optimistic = 'true';
  return el;
}

/* ------------------------------------------------------------------ */
/*  Add-card area builder                                               */
/* ------------------------------------------------------------------ */

function buildAddCardArea(columnId, onAddCard) {
  const area = document.createElement('div');
  area.className = 'add-card-area';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.innerHTML = `<span>＋</span> Add a card`;

  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.innerHTML = `
    <textarea placeholder="Enter card text…" rows="3"></textarea>
    <div class="add-card-form-actions">
      <button class="btn-primary" type="button">Add card</button>
      <button class="btn-cancel" type="button" title="Cancel">✕</button>
    </div>
  `;

  const textarea = form.querySelector('textarea');
  const addBtn = form.querySelector('.btn-primary');
  const cancelBtn = form.querySelector('.btn-cancel');

  function showForm() {
    btn.style.display = 'none';
    form.classList.add('visible');
    textarea.value = '';
    textarea.focus();
  }

  function hideForm() {
    form.classList.remove('visible');
    btn.style.display = '';
  }

  async function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    hideForm();
    await onAddCard(columnId, text);
  }

  btn.addEventListener('click', showForm);
  cancelBtn.addEventListener('click', hideForm);
  addBtn.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') hideForm();
  });

  area.appendChild(btn);
  area.appendChild(form);
  return area;
}

/* ------------------------------------------------------------------ */
/*  Incremental DOM updates                                             */
/* ------------------------------------------------------------------ */

/**
 * Upsert a card in the DOM.
 * Ensures the card element exists in exactly one column's card-list,
 * at the correct position relative to its neighbours.
 */
export function upsertCardInDom(card) {
  if (!card) return;

  // Remove the card element from wherever it currently lives
  const existing = boardEl.querySelector(`.card[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // Find the target column's card-list
  const list = boardEl.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!list) return;

  // Build fresh element
  const el = buildCardEl(card);

  // Insert in sorted position
  const col = getColumn(card.column_id);
  if (!col) {
    list.appendChild(el);
    updateColumnCount(card.column_id);
    return;
  }

  const sortedCards = [...col.cards].sort((a, b) => a.position - b.position);
  const idx = sortedCards.findIndex((c) => c.id === card.id);

  if (idx === -1 || idx === sortedCards.length - 1) {
    list.appendChild(el);
  } else {
    // Insert before the next card
    const nextCard = sortedCards[idx + 1];
    const nextEl = list.querySelector(`.card[data-card-id="${nextCard.id}"]`);
    if (nextEl) {
      list.insertBefore(el, nextEl);
    } else {
      list.appendChild(el);
    }
  }

  updateColumnCount(card.column_id);
}

/**
 * Re-render all cards in a column in the canonical server order.
 * Used after a `column-reorder` event.
 */
export function reorderColumnInDom(columnId, cards) {
  const list = boardEl.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!list) return;

  // Remove all existing card elements from this list
  list.querySelectorAll('.card:not(.card-ghost)').forEach((el) => el.remove());

  // Re-append in server order
  const sorted = [...cards].sort((a, b) => a.position - b.position);
  for (const card of sorted) {
    list.appendChild(buildCardEl(card));
  }

  updateColumnCount(columnId);
}

/**
 * Update the card-count badge in a column header.
 */
export function updateColumnCount(columnId) {
  const colEl = boardEl.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;
  const list = colEl.querySelector('.card-list');
  const count = list ? list.querySelectorAll('.card:not(.card-ghost)').length : 0;
  const badge = colEl.querySelector('.card-count');
  if (badge) badge.textContent = count;
}

/* ------------------------------------------------------------------ */
/*  Utility                                                             */
/* ------------------------------------------------------------------ */

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
