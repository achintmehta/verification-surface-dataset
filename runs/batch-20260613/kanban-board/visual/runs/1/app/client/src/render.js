import { getColumns } from './state.js';

const boardEl = document.getElementById('board');

// ─── Card ────────────────────────────────────────────────────────────────────

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  return el;
}

// ─── Column ──────────────────────────────────────────────────────────────────

function createColumnEl(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = col.id;

  el.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count" data-count="${col.id}">0</span>
    </div>
    <div class="card-list" data-list="${col.id}"></div>
    <button class="add-card-btn" data-add-col="${col.id}">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      Add card
    </button>
  `;

  return el;
}

// ─── Full board render ────────────────────────────────────────────────────────

export function renderBoard() {
  const columns = getColumns();
  boardEl.innerHTML = '';
  for (const col of columns) {
    const colEl = createColumnEl(col);
    boardEl.appendChild(colEl);
    renderColumnCards(col.id);
  }
}

// ─── Column cards render ──────────────────────────────────────────────────────

export function renderColumnCards(columnId) {
  const columns = getColumns();
  const col = columns.find((c) => c.id === columnId);
  if (!col) return;

  const list = boardEl.querySelector(`[data-list="${columnId}"]`);
  const countEl = boardEl.querySelector(`[data-count="${columnId}"]`);
  if (!list) return;

  // Preserve the drop indicator if it's in this list
  const indicator = list.querySelector('[data-indicator]');

  list.innerHTML = '';

  if (col.cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No cards yet';
    list.appendChild(empty);
  } else {
    for (const card of col.cards) {
      list.appendChild(createCardEl(card));
    }
  }

  // Re-insert indicator if it was there
  if (indicator) list.appendChild(indicator);

  if (countEl) countEl.textContent = col.cards.length;
}

// ─── Single card update ───────────────────────────────────────────────────────

/**
 * After an upsertCard() call, re-render the affected columns.
 * We re-render both the old column (if different) and the new column.
 */
export function renderCardUpdate(card, previousColumnId) {
  const columnsToUpdate = new Set([card.column_id]);
  if (previousColumnId && previousColumnId !== card.column_id) {
    columnsToUpdate.add(previousColumnId);
  }
  for (const colId of columnsToUpdate) {
    renderColumnCards(colId);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { boardEl };
