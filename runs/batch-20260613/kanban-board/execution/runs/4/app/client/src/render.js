/**
 * DOM rendering for the Kanban board.
 *
 * Performs surgical DOM updates rather than full re-renders to preserve
 * drag state and avoid flicker.
 */

import { getAllColumns, getColumn } from './state.js';

/* ------------------------------------------------------------------ */
/*  Full board render (initial load)                                    */
/* ------------------------------------------------------------------ */
export function renderBoard(boardEl, onAddCard) {
  boardEl.innerHTML = '';

  for (const col of getAllColumns()) {
    boardEl.appendChild(buildColumnEl(col, onAddCard));
  }
}

/* ------------------------------------------------------------------ */
/*  Reconcile a single column's card list against state                 */
/* ------------------------------------------------------------------ */
export function reconcileColumn(columnId) {
  const col    = getColumn(columnId);
  if (!col) return;

  const listEl = document.querySelector(
    `.column[data-column-id="${columnId}"] .cards-list`
  );
  if (!listEl) return;

  reconcileCardList(listEl, col.cards);
  updateCardCount(columnId, col.cards.length);
}

/* ------------------------------------------------------------------ */
/*  Reconcile all columns                                               */
/* ------------------------------------------------------------------ */
export function reconcileAll() {
  for (const col of getAllColumns()) {
    reconcileColumn(col.id);
  }
}

/* ------------------------------------------------------------------ */
/*  Card optimistic state helpers                                       */
/* ------------------------------------------------------------------ */
export function markCardOptimistic(cardId) {
  const el = document.querySelector(`.card[data-card-id="${cardId}"]`);
  el?.classList.add('optimistic');
}

export function clearCardOptimistic(cardId) {
  const el = document.querySelector(`.card[data-card-id="${cardId}"]`);
  el?.classList.remove('optimistic');
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function buildColumnEl(col, onAddCard) {
  const colEl = document.createElement('section');
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

  // Cards list
  const list = document.createElement('div');
  list.className = 'cards-list';
  list.setAttribute('role', 'list');
  for (const card of col.cards) {
    list.appendChild(buildCardEl(card));
  }
  colEl.appendChild(list);

  // Add card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = '+ Add a card';
  addBtn.addEventListener('click', () => onAddCard(col.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.setAttribute('draggable', 'true');
  el.setAttribute('role', 'listitem');
  el.textContent = card.text;
  return el;
}

/**
 * Reconcile the DOM card list to match the given ordered cards array.
 *
 * Strategy:
 *  1. Remove cards that no longer belong here.
 *  2. Insert / move cards to match the desired order.
 *
 * We preserve existing DOM nodes where possible to avoid losing drag state.
 */
function reconcileCardList(listEl, cards) {
  const desiredIds = cards.map((c) => c.id);

  // Remove cards not in desired list
  const existing = [...listEl.querySelectorAll('.card')];
  for (const el of existing) {
    if (!desiredIds.includes(el.dataset.cardId)) {
      el.remove();
    }
  }

  // Insert / reorder
  for (let i = 0; i < cards.length; i++) {
    const card   = cards[i];
    let   cardEl = listEl.querySelector(`.card[data-card-id="${card.id}"]`);

    if (!cardEl) {
      cardEl = buildCardEl(card);
    }

    // Update text in case it changed
    if (cardEl.textContent !== card.text) {
      cardEl.textContent = card.text;
    }

    // Find the current element at position i (skipping non-card children like placeholder)
    const cardChildren = [...listEl.children].filter((el) =>
      el.classList.contains('card')
    );

    if (cardChildren[i] !== cardEl) {
      // Insert before the card currently at position i, or append
      const ref = cardChildren[i] ?? null;
      listEl.insertBefore(cardEl, ref);
    }
  }
}

function updateCardCount(columnId, count) {
  const el = document.querySelector(
    `.column[data-column-id="${columnId}"] .card-count`
  );
  if (el) el.textContent = count;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
