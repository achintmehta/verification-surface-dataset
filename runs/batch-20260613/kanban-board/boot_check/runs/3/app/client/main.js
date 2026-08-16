/**
 * Kanban Board – Vanilla JS SPA
 *
 * Architecture:
 *  - `state`  : single source of truth (columns + cards)
 *  - `render` : full re-render from state (fast enough for this scale)
 *  - SSE      : patches state and re-renders on server events
 *  - Drag     : HTML5 drag-and-drop with optimistic updates
 */

const API = '/api';

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * state.columns : Array<{ id, title, position, cards: Array<Card> }>
 * Cards within each column are always sorted by position ascending.
 */
const state = {
  columns: [],
  dragging: null, // { cardId, sourceColumnId }
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function sortByPosition(arr) {
  return [...arr].sort((a, b) => a.position - b.position);
}

function findColumn(columnId) {
  return state.columns.find(c => c.id === columnId);
}

function findCard(cardId) {
  for (const col of state.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/** Remove a card from wherever it currently lives in state. */
function removeCardFromState(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

/** Upsert a card into state (remove from old column, add/update in new column). */
function upsertCard(card) {
  removeCardFromState(card.id);
  const col = findColumn(card.column_id);
  if (col) {
    col.cards.push(card);
    col.cards = sortByPosition(col.cards);
  }
}

// ─── API calls ───────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadBoard() {
  const columns = await apiFetch('/board');
  state.columns = columns.map(col => ({
    ...col,
    cards: sortByPosition(col.cards),
  }));
}

async function apiCreateCard(columnId, text) {
  return apiFetch('/cards', {
    method: 'POST',
    body: JSON.stringify({ columnId, text }),
  });
}

async function apiMoveCard(cardId, columnId, beforeId, afterId) {
  return apiFetch(`/cards/${cardId}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}

// ─── Render ──────────────────────────────────────────────────────────────────

const boardEl = document.getElementById('board');

function render() {
  // Preserve scroll positions per column
  const scrolls = {};
  boardEl.querySelectorAll('.column').forEach(el => {
    const list = el.querySelector('.card-list');
    if (list) scrolls[el.dataset.columnId] = list.scrollTop;
  });

  boardEl.innerHTML = '';

  for (const col of sortByPosition(state.columns)) {
    boardEl.appendChild(renderColumn(col));
  }

  // Restore scroll positions
  boardEl.querySelectorAll('.column').forEach(el => {
    const list = el.querySelector('.card-list');
    if (list && scrolls[el.dataset.columnId] != null) {
      list.scrollTop = scrolls[el.dataset.columnId];
    }
  });
}

function renderColumn(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span class="column-title">${escHtml(col.title)}</span>
    <span class="column-count">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  if (col.cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-col';
    empty.textContent = 'No cards yet';
    listEl.appendChild(empty);
  } else {
    for (const card of col.cards) {
      listEl.appendChild(renderCard(card));
    }
  }

  setupDropZone(listEl);
  colEl.appendChild(listEl);

  // Add card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = 'Add card';
  addBtn.addEventListener('click', () => openModal(col.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = true;
  el.textContent = card.text;

  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragend', onDragEnd);

  return el;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

let dragCardId = null;
let dragSourceColumnId = null;

function onDragStart(e) {
  dragCardId = e.currentTarget.dataset.cardId;
  const found = findCard(dragCardId);
  dragSourceColumnId = found?.column.id ?? null;

  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragCardId);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  // Clean up any lingering drop indicators
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  dragCardId = null;
  dragSourceColumnId = null;
}

function setupDropZone(listEl) {
  listEl.addEventListener('dragover', onDragOver);
  listEl.addEventListener('dragleave', onDragLeave);
  listEl.addEventListener('drop', onDrop);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;

  // Remove existing indicators in this list
  listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove());

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  const afterEl = getDragAfterElement(listEl, e.clientY);
  if (afterEl) {
    listEl.insertBefore(indicator, afterEl);
  } else {
    listEl.appendChild(indicator);
  }
}

function onDragLeave(e) {
  // Only remove if leaving the list itself (not a child)
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  }
}

function onDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove());

  const cardId = e.dataTransfer.getData('text/plain') || dragCardId;
  if (!cardId) return;

  const targetColumnId = listEl.dataset.columnId;
  const afterEl = getDragAfterElement(listEl, e.clientY);

  // Determine neighbour card ids
  const cardEls = [...listEl.querySelectorAll('.card:not(.dragging)')];
  const afterIdx = afterEl ? cardEls.indexOf(afterEl) : cardEls.length;

  // afterId  = card above the drop slot (lower position)
  // beforeId = card below the drop slot (higher position)
  const afterCardEl  = afterIdx > 0 ? cardEls[afterIdx - 1] : null;
  const beforeCardEl = afterEl ?? null;

  const afterId  = afterCardEl?.dataset.cardId  ?? null;
  const beforeId = beforeCardEl?.dataset.cardId ?? null;

  // Don't do anything if dropped in the same spot
  const found = findCard(cardId);
  if (
    found &&
    found.column.id === targetColumnId &&
    afterId  === getCardNeighbour(cardId, targetColumnId, 'after') &&
    beforeId === getCardNeighbour(cardId, targetColumnId, 'before')
  ) {
    return;
  }

  // ── Optimistic update ──────────────────────────────────────────────────────
  const optimisticPos = computeOptimisticPosition(targetColumnId, afterId, beforeId);
  const cardData = found?.card;
  if (!cardData) return;

  // Remove from source, insert into target at computed position
  removeCardFromState(cardId);
  const targetCol = findColumn(targetColumnId);
  if (targetCol) {
    const updatedCard = { ...cardData, column_id: targetColumnId, position: optimisticPos };
    targetCol.cards.push(updatedCard);
    targetCol.cards = sortByPosition(targetCol.cards);
  }

  // Mark as optimistic in DOM
  render();
  const optimisticEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (optimisticEl) optimisticEl.classList.add('optimistic');

  // ── Server request ─────────────────────────────────────────────────────────
  apiMoveCard(cardId, targetColumnId, beforeId, afterId)
    .then(({ card, renormalized }) => {
      // Reconcile: apply server's canonical state
      upsertCard(card);

      if (renormalized && renormalized.length > 0) {
        applyRenormalization(targetColumnId, renormalized);
      }

      render();
    })
    .catch(err => {
      console.error('[drag] Move failed, reverting:', err);
      // Revert: reload board from server
      loadBoard().then(render);
    });
}

/** Return the card element that the dragged card should be inserted before. */
function getDragAfterElement(listEl, y) {
  const draggableEls = [...listEl.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Infinity;

  for (const el of draggableEls) {
    const box = el.getBoundingClientRect();
    const offset = y - (box.top + box.height / 2);
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = el;
    }
  }
  return closest;
}

/** Get the card id immediately above or below a given card in a column. */
function getCardNeighbour(cardId, columnId, direction) {
  const col = findColumn(columnId);
  if (!col) return null;
  const idx = col.cards.findIndex(c => c.id === cardId);
  if (idx === -1) return null;
  if (direction === 'after')  return col.cards[idx - 1]?.id ?? null;
  if (direction === 'before') return col.cards[idx + 1]?.id ?? null;
  return null;
}

/** Compute an optimistic position for the card in the target column. */
function computeOptimisticPosition(columnId, afterId, beforeId) {
  const col = findColumn(columnId);
  if (!col) return 1000;

  const afterCard  = afterId  ? col.cards.find(c => c.id === afterId)  : null;
  const beforeCard = beforeId ? col.cards.find(c => c.id === beforeId) : null;

  const afterPos  = afterCard  ? afterCard.position  : null;
  const beforePos = beforeCard ? beforeCard.position : null;

  if (afterPos === null && beforePos === null) return 1000;
  if (afterPos === null) return beforePos - 500;
  if (beforePos === null) return afterPos + 500;
  return (afterPos + beforePos) / 2;
}

/** Apply a renormalization payload to state. */
function applyRenormalization(columnId, positions) {
  const col = findColumn(columnId);
  if (!col) return;
  for (const { id, position } of positions) {
    const card = col.cards.find(c => c.id === id);
    if (card) card.position = position;
  }
  col.cards = sortByPosition(col.cards);
}

// ─── Modal ───────────────────────────────────────────────────────────────────

const modalOverlay = document.getElementById('modal-overlay');
const modalColumnId = document.getElementById('modal-column-id');
const cardTextEl = document.getElementById('card-text');
const addCardForm = document.getElementById('add-card-form');
const modalCancel = document.getElementById('modal-cancel');

function openModal(columnId) {
  modalColumnId.value = columnId;
  cardTextEl.value = '';
  modalOverlay.hidden = false;
  cardTextEl.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
}

modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

addCardForm.addEventListener('submit', async e => {
  e.preventDefault();
  const columnId = modalColumnId.value;
  const text = cardTextEl.value.trim();
  if (!text) return;

  closeModal();

  try {
    // Optimistic: add a temporary card
    const tempId = `temp-${Date.now()}`;
    const col = findColumn(columnId);
    if (col) {
      const maxPos = col.cards.reduce((m, c) => Math.max(m, c.position), 0);
      col.cards.push({
        id: tempId,
        column_id: columnId,
        text,
        position: maxPos + 1000,
        created_at: new Date().toISOString(),
      });
      render();
      const tempEl = document.querySelector(`.card[data-card-id="${tempId}"]`);
      if (tempEl) tempEl.classList.add('optimistic');
    }

    const { card } = await apiCreateCard(columnId, text);

    // Replace temp card with real card
    removeCardFromState(tempId);
    upsertCard(card);
    render();
  } catch (err) {
    console.error('[modal] Create card failed:', err);
    // Remove temp card on failure
    removeCardFromState(`temp-${Date.now()}`);
    loadBoard().then(render);
  }
});

// ─── SSE ─────────────────────────────────────────────────────────────────────

const sseStatusEl = document.getElementById('sse-status');

function setSseStatus(status) {
  sseStatusEl.className = `sse-status ${status}`;
  sseStatusEl.title = status === 'connected'
    ? 'Real-time: connected'
    : 'Real-time: disconnected – reconnecting…';
}

function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    setSseStatus('connected');
    console.log('[sse] Connected');
  });

  es.addEventListener('error', () => {
    setSseStatus('disconnected');
    console.warn('[sse] Connection error – will retry');
  });

  // ── card:created ──────────────────────────────────────────────────────────
  es.addEventListener('card:created', e => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card:created', card.id);

    // Remove any temp card with same text in same column (our own optimistic)
    const col = findColumn(card.column_id);
    if (col) {
      const tempIdx = col.cards.findIndex(
        c => c.id.startsWith('temp-') && c.text === card.text && c.column_id === card.column_id
      );
      if (tempIdx !== -1) col.cards.splice(tempIdx, 1);
    }

    upsertCard(card);
    render();
  });

  // ── card:moved ────────────────────────────────────────────────────────────
  es.addEventListener('card:moved', e => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card:moved', card.id, '→', card.column_id, '@', card.position);

    upsertCard(card);
    render();
  });

  // ── column:renormalized ───────────────────────────────────────────────────
  es.addEventListener('column:renormalized', e => {
    const { columnId, positions } = JSON.parse(e.data);
    console.log('[sse] column:renormalized', columnId);

    applyRenormalization(columnId, positions);
    render();
  });

  return es;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap() {
  boardEl.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      Loading board…
    </div>
  `;

  try {
    await loadBoard();
    render();
    connectSSE();
  } catch (err) {
    console.error('[bootstrap] Failed to load board:', err);
    boardEl.innerHTML = `
      <div class="loading" style="color:var(--danger)">
        Failed to load board. Please refresh.
      </div>
    `;
  }
}

bootstrap();
