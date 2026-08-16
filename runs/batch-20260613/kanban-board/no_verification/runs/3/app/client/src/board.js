/**
 * Board DOM renderer.
 *
 * Provides fine-grained DOM update functions so we never do a full re-render
 * (which would disrupt in-progress drags or form inputs).
 *
 * Public API:
 *   renderBoard(boardEl, columns)          – initial full render
 *   renderCard(card)                       – insert or update a single card
 *   renderColumnCards(columnId, cards)     – replace all cards in a column
 *   removeCardFromColumn(cardId, columnId) – remove a card element
 *   updateCardCount(columnId)              – refresh the count badge
 */

import { columns } from './state.js';

// ---------------------------------------------------------------------------
// Full board render
// ---------------------------------------------------------------------------

/**
 * Render the entire board from the current state.
 * Clears the board element and rebuilds all columns.
 * @param {HTMLElement} boardEl
 */
export function renderBoard(boardEl) {
  // Remove loading indicator.
  boardEl.querySelector('#board-loading')?.remove();

  // Remove any existing columns (but keep non-column children).
  boardEl.querySelectorAll('.column').forEach((el) => el.remove());

  const sortedCols = [...columns.values()].sort((a, b) => a.position - b.position);
  for (const col of sortedCols) {
    boardEl.appendChild(createColumnEl(col));
  }
}

// ---------------------------------------------------------------------------
// Column element factory
// ---------------------------------------------------------------------------

function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-card-count" data-count-for="${col.id}">0</span>
    </div>
    <div class="card-list" data-list-for="${col.id}"></div>
    <div class="add-card-area" data-add-area-for="${col.id}">
      <button class="add-card-btn" data-add-btn-for="${col.id}">
        <span class="icon">＋</span> Add a card
      </button>
      <form class="add-card-form" data-add-form-for="${col.id}" style="display:none">
        <textarea
          placeholder="Enter card text…"
          rows="3"
          data-textarea-for="${col.id}"
        ></textarea>
        <div class="add-card-form-actions">
          <button type="submit" class="btn-add-confirm">Add card</button>
          <button type="button" class="btn-add-cancel" data-cancel-for="${col.id}">✕</button>
        </div>
      </form>
    </div>
  `;

  // Render cards.
  const listEl = colEl.querySelector('.card-list');
  const sortedCards = [...col.cards].sort((a, b) => a.position - b.position);
  for (const card of sortedCards) {
    listEl.appendChild(createCardEl(card));
  }

  updateCountBadge(colEl, col.cards.length);

  return colEl;
}

// ---------------------------------------------------------------------------
// Card element factory
// ---------------------------------------------------------------------------

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = false; // We use custom mouse-based DnD.
  el.innerHTML = `<span class="card-text">${escHtml(card.text)}</span>`;
  return el;
}

// ---------------------------------------------------------------------------
// Incremental DOM updates
// ---------------------------------------------------------------------------

/**
 * Insert or update a single card in the DOM, ensuring it appears in exactly
 * one column at the correct sorted position.
 * @param {object} card – canonical card from state
 */
export function renderCard(card) {
  // Remove the card from wherever it currently lives in the DOM.
  const existing = document.querySelector(`.card[data-card-id="${card.id}"]`);
  const prevColumnId = existing?.closest('.column')?.dataset.columnId;
  existing?.remove();

  // Find the target column element.
  const colEl = document.querySelector(`.column[data-column-id="${card.column_id}"]`);
  if (!colEl) return;

  const listEl = colEl.querySelector('.card-list');
  const newEl = createCardEl(card);

  // Insert at the correct sorted position.
  insertCardIntoList(listEl, newEl, card);

  // Update count badges.
  if (prevColumnId && prevColumnId !== card.column_id) {
    updateCountBadgeForColumn(prevColumnId);
  }
  updateCountBadgeForColumn(card.column_id);
}

/**
 * Replace all cards in a column (used after server renormalisation).
 * @param {string} columnId
 * @param {object[]} cards – sorted by position
 */
export function renderColumnCards(columnId, cards) {
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const listEl = colEl.querySelector('.card-list');

  // Remove all existing card elements.
  listEl.querySelectorAll('.card').forEach((el) => el.remove());

  // Re-insert in order.
  const sorted = [...cards].sort((a, b) => a.position - b.position);
  for (const card of sorted) {
    listEl.appendChild(createCardEl(card));
  }

  updateCountBadge(colEl, cards.length);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a card element into a list at the correct sorted position.
 * @param {HTMLElement} listEl
 * @param {HTMLElement} cardEl
 * @param {object}      card    – must have .position
 */
function insertCardIntoList(listEl, cardEl, card) {
  const siblings = Array.from(listEl.querySelectorAll('.card'));

  // Find the first sibling with a higher position.
  const after = siblings.find((el) => {
    const sibPos = getCardPosition(el.dataset.cardId, card.column_id);
    return sibPos !== null && sibPos > card.position;
  });

  if (after) {
    listEl.insertBefore(cardEl, after);
  } else {
    // Append before the placeholder if present, otherwise at the end.
    const placeholder = listEl.querySelector('.drop-placeholder');
    if (placeholder) {
      listEl.insertBefore(cardEl, placeholder);
    } else {
      listEl.appendChild(cardEl);
    }
  }
}

/**
 * Look up a card's position from the state store.
 * @param {string} cardId
 * @param {string} columnId
 * @returns {number|null}
 */
function getCardPosition(cardId, columnId) {
  const col = columns.get(columnId);
  if (!col) return null;
  const card = col.cards.find((c) => c.id === cardId);
  return card ? card.position : null;
}

function updateCountBadgeForColumn(columnId) {
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;
  const col = columns.get(columnId);
  updateCountBadge(colEl, col?.cards.length ?? 0);
}

function updateCountBadge(colEl, count) {
  const badge = colEl.querySelector('.column-card-count');
  if (badge) badge.textContent = count;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
