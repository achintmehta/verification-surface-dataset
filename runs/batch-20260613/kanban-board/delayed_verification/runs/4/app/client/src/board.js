/**
 * Board rendering module.
 *
 * Responsible for:
 *   - Rendering the full board from state
 *   - Rendering individual columns and cards
 *   - Providing fine-grained DOM update helpers used by SSE reconciliation
 *   - Wiring up the "Add card" forms
 */

import { columns, getColumnCards } from './state.js';

/** @type {HTMLElement} */
let boardEl;

/** @type {(columnId: string, text: string) => void} */
let onAddCard;

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Initialise the board renderer.
 *
 * @param {HTMLElement} el          - The board container element
 * @param {Function}    addCardCb   - Called when user submits a new card
 */
export function initBoard(el, addCardCb) {
  boardEl = el;
  onAddCard = addCardCb;
}

/**
 * Render the entire board from the current state.
 * Clears the board element and rebuilds all columns.
 */
export function renderBoard() {
  if (!boardEl) return;
  boardEl.innerHTML = '';
  const sorted = [...columns.values()].sort((a, b) => a.position - b.position);
  for (const col of sorted) {
    boardEl.appendChild(createColumnEl(col));
  }
}

/**
 * Re-render a single column's card list in place.
 * If the column element doesn't exist yet, append it.
 *
 * @param {string} columnId
 */
export function renderColumn(columnId) {
  if (!boardEl) return;
  const col = columns.get(columnId);
  if (!col) return;

  const existing = boardEl.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!existing) {
    boardEl.appendChild(createColumnEl(col));
    return;
  }

  // Replace only the card list and count badge
  const newList = createCardListEl(col);
  const oldList = existing.querySelector('.card-list');
  existing.replaceChild(newList, oldList);

  const countEl = existing.querySelector('.column-count');
  if (countEl) countEl.textContent = col.cards.length;
}

/**
 * Upsert a single card in the DOM.
 * Removes the card from its previous column (if any) and inserts it at the
 * correct sorted position in the target column.
 *
 * @param {object} card
 */
export function renderCard(card) {
  if (!boardEl) return; // board not yet initialized

  // Remove from wherever it currently lives in the DOM
  const existing = boardEl.querySelector(`.card[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  const colEl = boardEl.querySelector(`.column[data-column-id="${card.column_id}"]`);
  if (!colEl) return;

  const list = colEl.querySelector('.card-list');
  const cardEl = createCardEl(card);

  // Insert at the correct sorted position based on state
  const colCards = getColumnCards(card.column_id);
  const idx = colCards.findIndex(c => c.id === card.id);

  if (idx === -1) {
    // Card not in state yet – append at end
    list.appendChild(cardEl);
  } else if (idx >= colCards.length - 1) {
    // Last card – append at end of list
    list.appendChild(cardEl);
  } else {
    // Insert before the next card in sorted order
    const nextCardId = colCards[idx + 1].id;
    const nextCardEl = list.querySelector(`.card[data-card-id="${nextCardId}"]`);
    if (nextCardEl) {
      list.insertBefore(cardEl, nextCardEl);
    } else {
      list.appendChild(cardEl);
    }
  }

  // Update count badge
  const countEl = colEl.querySelector('.column-count');
  if (countEl) countEl.textContent = colCards.length;
}

/* ── Element factories ──────────────────────────────────────────────────── */

function createColumnEl(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = col.id;

  el.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">${col.cards.length}</span>
    </div>
  `;

  el.appendChild(createCardListEl(col));
  el.appendChild(createAddCardArea(col.id));

  return el;
}

function createCardListEl(col) {
  const list = document.createElement('div');
  list.className = 'card-list';

  const sorted = [...col.cards].sort((a, b) => a.position - b.position);
  for (const card of sorted) {
    list.appendChild(createCardEl(card));
  }

  return list;
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  return el;
}

function createAddCardArea(columnId) {
  const area = document.createElement('div');
  area.className = 'add-card-area';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = 'Add a card';
  btn.type = 'button';

  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.innerHTML = `
    <textarea placeholder="Enter card text…" rows="3"></textarea>
    <div class="add-card-form-actions">
      <button type="button" class="btn-add-submit">Add card</button>
      <button type="button" class="btn-add-cancel">✕</button>
    </div>
  `;

  const textarea  = form.querySelector('textarea');
  const submitBtn = form.querySelector('.btn-add-submit');
  const cancelBtn = form.querySelector('.btn-add-cancel');

  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    form.classList.add('open');
    textarea.focus();
  });

  const close = () => {
    form.classList.remove('open');
    btn.style.display = '';
    textarea.value = '';
  };

  cancelBtn.addEventListener('click', close);

  const submit = () => {
    const text = textarea.value.trim();
    if (!text) return;
    onAddCard(columnId, text);
    close();
  };

  submitBtn.addEventListener('click', submit);

  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') close();
  });

  area.appendChild(btn);
  area.appendChild(form);
  return area;
}

/* ── Utilities ──────────────────────────────────────────────────────────── */

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
