/**
 * DOM rendering helpers for the Kanban board.
 */

/**
 * Render the full board from state.
 * @param {import('./state.js').BoardState} state
 * @param {object} handlers - { onAddCard, onDragStart, onDragOver, onDrop, onDragEnd }
 */
export function renderBoard(state, handlers) {
  const board = document.getElementById('board');
  const loading = document.getElementById('board-loading');
  if (loading) loading.remove();

  // Build a set of existing column elements
  const existingCols = new Map();
  for (const el of board.querySelectorAll('.column')) {
    existingCols.set(el.dataset.columnId, el);
  }

  const sortedCols = state.getSortedColumns();

  // Remove columns no longer in state
  for (const [id, el] of existingCols) {
    if (!state.columns.has(id)) el.remove();
  }

  // Insert / update columns in order
  sortedCols.forEach((col, idx) => {
    let colEl = existingCols.get(col.id);
    if (!colEl) {
      colEl = createColumnElement(col, handlers);
      board.appendChild(colEl);
    } else {
      // Ensure correct DOM order
      const children = [...board.children].filter((c) => c.classList.contains('column'));
      if (children[idx] !== colEl) {
        board.insertBefore(colEl, children[idx] || null);
      }
    }
    renderCards(colEl, state.getSortedCards(col.id), handlers);
    updateColumnCount(colEl, state.getSortedCards(col.id).length);
  });
}

/**
 * Re-render only the cards inside a single column.
 * @param {string} columnId
 * @param {import('./state.js').BoardState} state
 * @param {object} handlers
 */
export function renderColumn(columnId, state, handlers) {
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;
  const cards = state.getSortedCards(columnId);
  renderCards(colEl, cards, handlers);
  updateColumnCount(colEl, cards.length);
}

/* ── Internal helpers ─────────────────────────────────────────────── */

function createColumnElement(col, handlers) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = col.id;

  el.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">0</span>
    </div>
    <div class="card-list" data-column-id="${col.id}"></div>
    <button class="add-card-btn" data-column-id="${col.id}">
      <span>＋</span> Add a card
    </button>
  `;

  // Add-card button
  el.querySelector('.add-card-btn').addEventListener('click', () => {
    handlers.onAddCard(col.id);
  });

  // Drag-over / drop on the card list
  const list = el.querySelector('.card-list');
  list.addEventListener('dragover', (e) => handlers.onDragOver(e, list));
  list.addEventListener('drop', (e) => handlers.onDrop(e, list));
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) list.classList.remove('drag-over');
  });

  return el;
}

function renderCards(colEl, cards, handlers) {
  const list = colEl.querySelector('.card-list');

  // Build map of existing card elements
  const existing = new Map();
  for (const el of list.querySelectorAll('.card')) {
    existing.set(el.dataset.cardId, el);
  }

  // Remove ghost if present
  const ghost = list.querySelector('.card-ghost');
  if (ghost) ghost.remove();

  // Remove cards no longer in this column
  for (const [id, el] of existing) {
    if (!cards.find((c) => c.id === id)) el.remove();
  }

  // Insert / update cards in order
  cards.forEach((card, idx) => {
    let cardEl = existing.get(card.id);
    if (!cardEl) {
      cardEl = createCardElement(card, handlers);
    } else {
      // Update text if changed
      const textEl = cardEl.querySelector('.card-text');
      if (textEl && textEl.textContent !== card.text) textEl.textContent = card.text;
      // Remove optimistic flag once server confirms
      cardEl.classList.remove('optimistic');
    }

    // Ensure correct DOM order
    const children = [...list.children].filter((c) => c.classList.contains('card'));
    if (children[idx] !== cardEl) {
      list.insertBefore(cardEl, children[idx] || null);
    }
  });
}

function createCardElement(card, handlers) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = true;

  el.innerHTML = `<span class="card-text">${escHtml(card.text)}</span>`;

  el.addEventListener('dragstart', (e) => handlers.onDragStart(e, el));
  el.addEventListener('dragend', (e) => handlers.onDragEnd(e, el));

  return el;
}

function updateColumnCount(colEl, count) {
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = count;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
