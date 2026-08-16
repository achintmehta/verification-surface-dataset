/**
 * DOM rendering for the Kanban board.
 * Pure render functions – they read from state and write to the DOM.
 */

import { getColumns, getColumnById } from './state.js';

const boardEl = document.getElementById('board');

/* ── Full board render ────────────────────────────────────── */
export function renderBoard(onAddCard, onDragStart, onDragOver, onDrop, onDragEnd) {
  boardEl.innerHTML = '';
  for (const col of getColumns()) {
    boardEl.appendChild(
      buildColumn(col, onAddCard, onDragStart, onDragOver, onDrop, onDragEnd)
    );
  }
}

/* ── Single column render ─────────────────────────────────── */
function buildColumn(col, onAddCard, onDragStart, onDragOver, onDrop, onDragEnd) {
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
    listEl.appendChild(buildCard(card, onDragStart, onDragEnd));
  }

  // Drag-over events on the list
  listEl.addEventListener('dragover', e => onDragOver(e, col.id));
  listEl.addEventListener('drop',     e => onDrop(e, col.id));
  listEl.addEventListener('dragleave', e => {
    if (!listEl.contains(e.relatedTarget)) {
      listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove());
      colEl.classList.remove('drag-over');
    }
  });

  colEl.appendChild(listEl);

  // Add-card area
  colEl.appendChild(buildAddCardArea(col.id, onAddCard));

  return colEl;
}

/* ── Single card element ──────────────────────────────────── */
export function buildCard(card, onDragStart, onDragEnd) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;
  el.textContent = card.text;

  el.addEventListener('dragstart', e => onDragStart(e, card.id));
  el.addEventListener('dragend',   e => onDragEnd(e));

  return el;
}

/* ── Add-card area ────────────────────────────────────────── */
function buildAddCardArea(columnId, onAddCard) {
  const area = document.createElement('div');
  area.className = 'add-card-area';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';

  btn.addEventListener('click', () => {
    area.innerHTML = '';
    area.appendChild(buildAddCardForm(columnId, onAddCard, area, btn));
  });

  area.appendChild(btn);
  return area;
}

function buildAddCardForm(columnId, onAddCard, area, btn) {
  const form = document.createElement('div');
  form.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text…';
  textarea.rows = 3;

  const actions = document.createElement('div');
  actions.className = 'add-card-form-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary';
  addBtn.textContent = 'Add card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-ghost';
  cancelBtn.textContent = 'Cancel';

  const submit = () => {
    const text = textarea.value.trim();
    if (!text) return;
    onAddCard(columnId, text);
    area.innerHTML = '';
    area.appendChild(btn);
  };

  addBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => {
    area.innerHTML = '';
    area.appendChild(btn);
  });
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { area.innerHTML = ''; area.appendChild(btn); }
  });

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  // Auto-focus
  requestAnimationFrame(() => textarea.focus());

  return form;
}

/* ── Incremental DOM updates (no full re-render) ──────────── */

/**
 * Update a single card's DOM element in place, or move it to the right column.
 * Called after server confirms a card:created or card:moved event.
 */
export function reconcileCard(card, onDragStart, onDragEnd) {
  // Remove any existing element for this card (could be in wrong column)
  const existing = document.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // Find the target column's card list
  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!listEl) return;

  // Build fresh element
  const cardEl = buildCard(card, onDragStart, onDragEnd);

  // Insert at the correct position based on state ordering
  const col = getColumnById(card.column_id);
  if (!col) { listEl.appendChild(cardEl); return; }

  const idx = col.cards.findIndex(c => c.id === card.id);
  const children = [...listEl.querySelectorAll('.card')];

  if (idx >= children.length) {
    listEl.appendChild(cardEl);
  } else {
    listEl.insertBefore(cardEl, children[idx]);
  }

  updateColumnCount(card.column_id);
}

/**
 * Re-render all cards in a column (used after renormalisation).
 */
export function reconcileColumn(columnId, onDragStart, onDragEnd) {
  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  const col = getColumnById(columnId);
  if (!col) return;

  // Remove all existing card elements
  listEl.querySelectorAll('.card').forEach(el => el.remove());

  // Re-insert in correct order
  for (const card of col.cards) {
    listEl.appendChild(buildCard(card, onDragStart, onDragEnd));
  }

  updateColumnCount(columnId);
}

export function updateColumnCount(columnId) {
  const col = getColumnById(columnId);
  if (!col) return;
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;
  const countEl = colEl.querySelector('.column-count');
  if (countEl) countEl.textContent = col.cards.length;
}

/* ── Drop indicator helpers ───────────────────────────────── */

export function clearDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
}

/**
 * Show a drop indicator line in the list at the given position.
 * Returns { afterId, beforeId } – the card ids surrounding the drop point.
 */
export function showDropIndicator(listEl, clientY) {
  clearDropIndicators();

  const colEl = listEl.closest('.column');
  if (colEl) colEl.classList.add('drag-over');

  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

  let afterId  = null;
  let beforeId = null;
  let insertBefore = null; // DOM node to insert indicator before (null = append)

  if (cards.length === 0) {
    // Empty column – just append indicator
    const ind = makeIndicator();
    listEl.appendChild(ind);
    return { afterId: null, beforeId: null };
  }

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;

    if (clientY < mid) {
      // Drop above cards[i]
      beforeId     = cards[i].dataset.cardId;
      afterId      = i > 0 ? cards[i - 1].dataset.cardId : null;
      insertBefore = cards[i];
      break;
    }
  }

  if (insertBefore === null) {
    // Drop below all cards
    afterId  = cards[cards.length - 1].dataset.cardId;
    beforeId = null;
  }

  const ind = makeIndicator();
  if (insertBefore) {
    listEl.insertBefore(ind, insertBefore);
  } else {
    listEl.appendChild(ind);
  }

  return { afterId, beforeId };
}

function makeIndicator() {
  const el = document.createElement('div');
  el.className = 'drop-indicator';
  return el;
}
