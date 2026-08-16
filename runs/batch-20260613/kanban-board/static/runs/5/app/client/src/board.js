/**
 * Board rendering module.
 *
 * Responsible for creating and updating the DOM to reflect the current state.
 * All DOM mutations go through this module so that the rest of the app can
 * treat the DOM as a pure projection of `state`.
 *
 * Strategy:
 *   - On initial load: build the full DOM from scratch.
 *   - On SSE events:   reconcile individual columns rather than re-rendering
 *                      the whole board, to avoid disrupting an in-progress drag.
 */

import { state, findColumn } from './state.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the entire board from the current state.
 * Replaces all existing column elements.
 *
 * @param {HTMLElement} boardEl
 * @param {Function}    onAddCard  – (columnId) => void
 */
export function renderBoard(boardEl, onAddCard) {
  // Remove loading indicator and any existing columns.
  boardEl.innerHTML = '';

  for (const col of state.columns) {
    const colEl = createColumnEl(col, onAddCard);
    boardEl.appendChild(colEl);
  }
}

/**
 * Reconcile a single column's card list against the current state.
 * Called after SSE events so we don't re-render the whole board.
 *
 * @param {string} columnId
 */
export function reconcileColumn(columnId) {
  const col = findColumn(columnId);
  if (!col) return;

  const colEl = document.querySelector(`[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const cardListEl = colEl.querySelector('.card-list');
  if (!cardListEl) return;

  // Reconcile the card list.
  reconcileCardList(cardListEl, col.cards);

  // Update the card count badge.
  const countEl = colEl.querySelector('.column-count');
  if (countEl) countEl.textContent = col.cards.length;
}

/**
 * Reconcile all columns.  Used after a column:renormed event or after the
 * initial load to ensure every column is up to date.
 */
export function reconcileAllColumns() {
  for (const col of state.columns) {
    reconcileColumn(col.id);
  }
}

// ---------------------------------------------------------------------------
// Column creation
// ---------------------------------------------------------------------------

function createColumnEl(col, onAddCard) {
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
  const cardListEl = document.createElement('div');
  cardListEl.className = 'card-list';
  cardListEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    cardListEl.appendChild(createCardEl(card));
  }

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.type = 'button';
  addBtn.dataset.columnId = col.id;
  addBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    Add a card
  `;
  addBtn.addEventListener('click', () => onAddCard(col.id));

  colEl.appendChild(header);
  colEl.appendChild(cardListEl);
  colEl.appendChild(addBtn);

  return colEl;
}

// ---------------------------------------------------------------------------
// Card creation
// ---------------------------------------------------------------------------

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  el.setAttribute('draggable', 'false'); // we use pointer events, not HTML5 DnD
  return el;
}

// ---------------------------------------------------------------------------
// Reconciliation helpers
// ---------------------------------------------------------------------------

/**
 * Reconcile the card list DOM to match the given ordered array of cards.
 *
 * Uses a keyed reconciliation approach:
 *   1. Remove cards that no longer exist in the column.
 *   2. Add cards that are new.
 *   3. Reorder cards to match the canonical order.
 *
 * This preserves existing DOM nodes where possible, which is important for
 * not disrupting an in-progress drag on another card.
 *
 * @param {HTMLElement} cardListEl
 * @param {import('./state.js').Card[]} cards  – ordered by position
 */
function reconcileCardList(cardListEl, cards) {
  const existingEls = new Map(); // cardId → element

  // Collect existing card elements (skip placeholders and other non-card nodes).
  for (const child of Array.from(cardListEl.children)) {
    if (child.classList.contains('card') && child.dataset.cardId) {
      existingEls.set(child.dataset.cardId, child);
    }
  }

  // Remove cards that are no longer in this column.
  for (const [id, el] of existingEls) {
    if (!cards.find((c) => c.id === id)) {
      el.remove();
      existingEls.delete(id);
    }
  }

  // Build the desired ordered list of elements, creating new ones as needed.
  const orderedEls = cards.map((card) => {
    if (existingEls.has(card.id)) {
      return existingEls.get(card.id);
    }
    const el = createCardEl(card);
    existingEls.set(card.id, el);
    return el;
  });

  // Re-insert elements in the correct order.
  // We only move elements that are out of place to minimise DOM churn.
  for (let i = 0; i < orderedEls.length; i++) {
    const el = orderedEls[i];
    // Find the current position of this element among card children only.
    const cardChildren = Array.from(cardListEl.children).filter(
      (c) => c.classList.contains('card'),
    );

    if (cardChildren[i] !== el) {
      // Insert before the element currently at position i, or append.
      const refNode = cardChildren[i] ?? null;
      cardListEl.insertBefore(el, refNode);
    }
  }
}
