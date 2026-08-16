/**
 * board.js – DOM rendering for the Kanban board.
 *
 * Responsible for:
 *  - Building column and card elements from state.
 *  - Wiring up drag-and-drop via drag.js.
 *  - Wiring up the "add card" form per column.
 *  - Providing fine-grained DOM update helpers (upsertCardEl, reorderColumnEl)
 *    so SSE events can reconcile without a full re-render.
 */

import { makeDraggable, makeDropZone } from './drag.js';
import { state }                       from './state.js';

// ---------------------------------------------------------------------------
// Callbacks injected by main.js
// ---------------------------------------------------------------------------
let _onAddCard  = async (_columnId, _text) => {};
let _onMoveCard = async (_intent) => {};

export function setCallbacks({ onAddCard, onMoveCard }) {
  _onAddCard  = onAddCard;
  _onMoveCard = onMoveCard;
}

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------
const boardEl   = document.getElementById('board');
const loadingEl = document.getElementById('board-loading');

// ---------------------------------------------------------------------------
// Full board render (called once on initial load)
// ---------------------------------------------------------------------------

/**
 * Render the entire board from `state`.
 */
export function renderBoard() {
  loadingEl?.remove();

  // Remove any existing columns.
  boardEl.querySelectorAll('.column').forEach(el => el.remove());

  for (const col of state.columns) {
    boardEl.appendChild(buildColumnEl(col));
  }
}

// ---------------------------------------------------------------------------
// Column builder
// ---------------------------------------------------------------------------

function buildColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className        = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const titleEl = document.createElement('span');
  titleEl.className   = 'column-title';
  titleEl.textContent = col.title;

  const countEl = document.createElement('span');
  countEl.className   = 'column-count';
  countEl.textContent = col.cards.length;

  header.appendChild(titleEl);
  header.appendChild(countEl);
  colEl.appendChild(header);

  // Card list (droppable)
  const listEl = document.createElement('div');
  listEl.className        = 'card-list';
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(buildCardEl(card));
  }

  makeDropZone(listEl, col.id, _onMoveCard);
  colEl.appendChild(listEl);

  // Add-card area
  colEl.appendChild(buildAddCardArea(col.id));

  return colEl;
}

// ---------------------------------------------------------------------------
// Card builder
// ---------------------------------------------------------------------------

function buildCardEl(card) {
  const cardEl = document.createElement('div');
  cardEl.className      = 'card';
  cardEl.dataset.cardId = card.id;

  const textEl = document.createElement('p');
  textEl.className   = 'card-text';
  textEl.textContent = card.text;

  cardEl.appendChild(textEl);
  makeDraggable(cardEl);
  return cardEl;
}

// ---------------------------------------------------------------------------
// Add-card area builder
// ---------------------------------------------------------------------------

function buildAddCardArea(columnId) {
  const area = document.createElement('div');
  area.className = 'add-card-area';

  // Toggle button (shown by default)
  const toggle = document.createElement('button');
  toggle.className = 'add-card-toggle';
  toggle.innerHTML = '<span class="plus-icon">+</span> Add a card';

  // Form (hidden by default)
  const form = document.createElement('div');
  form.className     = 'add-card-form';
  form.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.className   = 'add-card-textarea';
  textarea.placeholder = 'Enter card text…';
  textarea.rows        = 3;

  const actions = document.createElement('div');
  actions.className = 'add-card-actions';

  const addBtn = document.createElement('button');
  addBtn.className   = 'btn btn-primary';
  addBtn.textContent = 'Add card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'btn btn-ghost';
  cancelBtn.textContent = '✕';
  cancelBtn.title       = 'Cancel';

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  area.appendChild(toggle);
  area.appendChild(form);

  // --- Interaction ---------------------------------------------------------

  function showForm() {
    toggle.style.display = 'none';
    form.style.display   = 'flex';
    textarea.value       = '';
    textarea.focus();
  }

  function hideForm() {
    form.style.display   = 'none';
    toggle.style.display = '';
  }

  toggle.addEventListener('click', showForm);
  cancelBtn.addEventListener('click', hideForm);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === 'Escape') hideForm();
  });

  addBtn.addEventListener('click', submitCard);

  async function submitCard() {
    const text = textarea.value.trim();
    if (!text) return;

    addBtn.disabled = true;
    try {
      await _onAddCard(columnId, text);
      hideForm();
    } catch (err) {
      console.error('Failed to add card:', err);
      textarea.focus();
    } finally {
      addBtn.disabled = false;
    }
  }

  return area;
}

// ---------------------------------------------------------------------------
// Fine-grained DOM update helpers (used by SSE reconciliation)
// ---------------------------------------------------------------------------

/**
 * Insert or update a card element to reflect the canonical server state.
 * Ensures the card appears in exactly one column and in the correct position.
 *
 * Algorithm:
 *  1. Remove the card from wherever it currently lives in the DOM.
 *  2. Find the target column's card-list.
 *  3. Walk the state array for that column to find the correct insertion index.
 *  4. Insert before the DOM sibling at that index (or append if last).
 *
 * @param {object}  card         – canonical card from server / state
 * @param {boolean} [flash=false] – apply reconcile-flash animation
 */
export function upsertCardEl(card, flash = false) {
  // 1. Remove from wherever it currently lives in the DOM.
  const existing = document.querySelector(`.card[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // 2. Find the target column's card-list.
  const listEl = document.querySelector(
    `.card-list[data-column-id="${card.column_id}"]`
  );
  if (!listEl) return;

  // 3. Build a fresh element.
  const cardEl = buildCardEl(card);
  if (flash) {
    // Trigger the animation on the next frame so the element is in the DOM.
    requestAnimationFrame(() => cardEl.classList.add('reconciled'));
  }

  // 4. Find the correct insertion point using the canonical state order.
  const colState = state.columns.find(c => c.id === card.column_id);
  if (!colState) {
    listEl.appendChild(cardEl);
    updateColumnCount(card.column_id);
    return;
  }

  const stateIdx = colState.cards.findIndex(c => c.id === card.id);

  // Get the current real card elements in the list (no placeholders).
  const domCards = [...listEl.querySelectorAll('.card')];

  if (stateIdx === -1 || stateIdx >= domCards.length) {
    // Append at end.
    listEl.appendChild(cardEl);
  } else {
    // Insert before the card currently at stateIdx.
    listEl.insertBefore(cardEl, domCards[stateIdx]);
  }

  updateColumnCount(card.column_id);
}

/**
 * Re-render all cards in a column to match the canonical order in `state`.
 * Used after a renormalisation broadcast or after an optimistic move.
 *
 * @param {string} columnId
 */
export function reorderColumnEl(columnId) {
  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  const colState = state.columns.find(c => c.id === columnId);
  if (!colState) return;

  // Remove all existing card elements (but keep the placeholder if present).
  listEl.querySelectorAll('.card').forEach(el => el.remove());

  // Re-insert in canonical order.
  for (const card of colState.cards) {
    const cardEl = buildCardEl(card);
    listEl.appendChild(cardEl);
  }

  updateColumnCount(columnId);
}

/**
 * Update the card-count badge in a column header.
 * @param {string} columnId
 */
function updateColumnCount(columnId) {
  const colEl   = document.querySelector(`.column[data-column-id="${columnId}"]`);
  const countEl = colEl?.querySelector('.column-count');
  if (!countEl) return;

  const colState = state.columns.find(c => c.id === columnId);
  countEl.textContent = colState?.cards.length ?? 0;
}
