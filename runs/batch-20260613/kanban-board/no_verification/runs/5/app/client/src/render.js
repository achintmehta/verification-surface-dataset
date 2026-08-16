/**
 * DOM rendering module.
 *
 * Provides functions to build and update the Kanban board DOM from the store state.
 * Uses targeted DOM mutations rather than full re-renders to avoid disrupting
 * in-flight drag operations.
 */

import { getState } from './store.js';

const boardEl = () => document.getElementById('board');

// ── Full render ───────────────────────────────────────────────────────────────

/**
 * Render the entire board from scratch (called once on initial load).
 */
export function renderBoard() {
  const board = boardEl();
  board.innerHTML = '';

  const { columns, columnOrder } = getState();
  for (const colId of columnOrder) {
    const col = columns.get(colId);
    if (col) board.appendChild(buildColumnEl(col));
  }
}

// ── Column builders ───────────────────────────────────────────────────────────

function buildColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count" data-count="${col.id}">${col.cards.length}</span>
    </div>
    <div class="card-list" data-list="${col.id}"></div>
    <button class="add-card-btn" data-add-card="${col.id}" aria-label="Add card to ${escHtml(col.title)}">
      <span class="icon">＋</span> Add a card
    </button>
  `;

  const listEl = colEl.querySelector('.card-list');
  for (const card of col.cards) {
    listEl.appendChild(buildCardEl(card));
  }

  return colEl;
}

function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;

  const date = new Date(card.created_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  el.innerHTML = `
    <div class="card-text">${escHtml(card.text)}</div>
    <div class="card-meta">${date}</div>
  `;

  return el;
}

// ── Targeted updates ──────────────────────────────────────────────────────────

/**
 * Reconcile a single column's card list against the store state.
 * Preserves the dragging card's DOM element to avoid interrupting a drag.
 *
 * @param {string} columnId
 */
export function reconcileColumn(columnId) {
  const { columns } = getState();
  const col = columns.get(columnId);
  if (!col) return;

  const colEl = document.querySelector(`[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const listEl = colEl.querySelector('.card-list');
  if (!listEl) return;

  // Build a map of existing card elements
  const existingEls = new Map();
  for (const el of listEl.querySelectorAll('[data-card-id]')) {
    existingEls.set(el.dataset.cardId, el);
  }

  // Remove drop indicators before reconciling
  listEl.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  // Rebuild the list in the correct order
  const fragment = document.createDocumentFragment();
  for (const card of col.cards) {
    let el = existingEls.get(card.id);
    if (el) {
      // Update position data attribute
      el.dataset.position = card.position;
      existingEls.delete(card.id);
    } else {
      el = buildCardEl(card);
    }
    fragment.appendChild(el);
  }

  // Remove cards that are no longer in this column
  for (const el of existingEls.values()) {
    el.remove();
  }

  listEl.appendChild(fragment);

  // Update count badge
  const countEl = colEl.querySelector(`[data-count="${columnId}"]`);
  if (countEl) countEl.textContent = col.cards.length;
}

/**
 * Ensure a card element exists in the correct column and is not duplicated.
 * Called after SSE card:created or card:moved events.
 *
 * @param {object} card
 */
export function reconcileCard(card) {
  // Find which columns currently have a DOM element for this card
  const columnsWithCard = new Set();
  const existing = document.querySelectorAll(`[data-card-id="${card.id}"]`);
  for (const el of existing) {
    const colEl = el.closest('[data-column-id]');
    if (colEl) columnsWithCard.add(colEl.dataset.columnId);
    el.remove();
  }

  // Reconcile the target column (adds the card in the right position)
  reconcileColumn(card.column_id);

  // Reconcile any source columns that lost the card (update their counts)
  for (const colId of columnsWithCard) {
    if (colId !== card.column_id) {
      reconcileColumn(colId);
    }
  }

  // Update counts for all columns to stay in sync
  const { columns } = getState();
  for (const col of columns.values()) {
    const colEl = document.querySelector(`[data-column-id="${col.id}"]`);
    if (colEl) {
      const countEl = colEl.querySelector(`[data-count="${col.id}"]`);
      if (countEl) countEl.textContent = col.cards.length;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
