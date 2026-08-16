import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const store = new BoardStore();

// Track in-flight drag state.
let dragState = null; // { cardId }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve focus/text of an open "add card" textarea across re-renders.
  const active = document.activeElement;
  const activeColumn = active?.classList?.contains('add-card__input')
    ? active.dataset.columnId
    : null;
  const activeValue = activeColumn ? active.value : '';
  const selStart = activeColumn ? active.selectionStart : 0;

  boardEl.innerHTML = '';

  for (const column of store.columns) {
    boardEl.appendChild(renderColumn(column, { activeColumn, activeValue, selStart }));
  }
}

function renderColumn(column, focusInfo) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const title = document.createElement('h2');
  title.className = 'column__title';
  title.innerHTML = `<span>${escapeHtml(column.title)}</span>` +
    `<span class="column__count">${column.cards.length}</span>`;
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = column.id;

  for (const card of column.cards) {
    list.appendChild(renderCard(card));
  }

  // Drop handling for the column list (covers empty columns and gaps).
  list.addEventListener('dragover', onListDragOver);
  list.addEventListener('dragleave', onListDragLeave);
  list.addEventListener('drop', onListDrop);

  colEl.appendChild(list);
  colEl.appendChild(renderAddCard(column, focusInfo));
  return colEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.dataset.columnId = card.column_id;
  li.textContent = card.text;

  li.addEventListener('dragstart', onCardDragStart);
  li.addEventListener('dragend', onCardDragEnd);
  return li;
}

function renderAddCard(column, focusInfo) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const input = document.createElement('textarea');
  input.className = 'add-card__input';
  input.rows = 2;
  input.placeholder = '+ Add a card…';
  input.dataset.columnId = column.id;

  const hint = document.createElement('div');
  hint.className = 'add-card__hint';
  hint.textContent = 'Press Enter to add';

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        // Server broadcasts the created card; SSE handler inserts it.
        await createCard(column.id, text);
      } catch (err) {
        console.error('Failed to create card', err);
      }
    }
  });

  wrap.appendChild(input);
  wrap.appendChild(hint);

  // Restore focus if this column's input was active before re-render.
  if (focusInfo.activeColumn === column.id) {
    queueMicrotask(() => {
      input.value = focusInfo.activeValue;
      input.focus();
      try {
        input.setSelectionRange(focusInfo.selStart, focusInfo.selStart);
      } catch {
        /* ignore */
      }
    });
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function onCardDragStart(e) {
  const cardId = e.currentTarget.dataset.cardId;
  dragState = { cardId };
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try {
    e.dataTransfer.setData('text/plain', cardId);
  } catch {
    /* some browsers require this */
  }
}

function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  clearIndicators();
  dragState = null;
}

function onListDragOver(e) {
  if (!dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const list = e.currentTarget;
  list.classList.add('drag-over');

  clearIndicators();
  const before = getCardAfterPoint(list, e.clientY);
  if (before) before.classList.add('drop-indicator-before');
}

function onListDragLeave(e) {
  // Only clear when leaving the list entirely.
  if (e.currentTarget.contains(e.relatedTarget)) return;
  e.currentTarget.classList.remove('drag-over');
  clearIndicators();
}

async function onListDrop(e) {
  if (!dragState) return;
  e.preventDefault();
  const list = e.currentTarget;
  list.classList.remove('drag-over');
  clearIndicators();

  const cardId = dragState.cardId;
  const targetColumnId = list.dataset.columnId;

  // Determine the card that should sit immediately below the dropped card.
  const beforeEl = getCardAfterPoint(list, e.clientY);
  let beforeId = beforeEl ? beforeEl.dataset.cardId : null;
  if (beforeId === cardId) beforeId = null;

  // The card immediately above (the "after" neighbour) is derived from the
  // target column order *after* removing the moved card.
  const afterId = computeAfterId(targetColumnId, cardId, beforeId);

  // 1) Optimistic update — reposition locally and render immediately.
  store.optimisticMove(cardId, targetColumnId, beforeId);

  // 2) Send intent to the server.
  try {
    const result = await moveCard(cardId, { columnId: targetColumnId, beforeId, afterId });
    // 3) Reconcile against the canonical card. The SSE event will also
    //    arrive; applying here too keeps the dragging client snappy.
    if (result.renormalized) {
      store.applyRenormalized(result.renormalized);
    } else if (result.card) {
      store.upsertCard(result.card);
    }
  } catch (err) {
    console.error('Move failed, reloading authoritative board', err);
    await loadBoard();
  }
}

/**
 * Compute the `afterId` (the card that should sit immediately above the moved
 * card) given the target column's current order and the chosen beforeId.
 */
function computeAfterId(columnId, cardId, beforeId) {
  const col = store.getColumn(columnId);
  if (!col) return null;
  const order = col.cards.filter((c) => c.id !== cardId);
  if (!beforeId) {
    // Dropped at the bottom: after = last remaining card.
    return order.length ? order[order.length - 1].id : null;
  }
  const idx = order.findIndex((c) => c.id === beforeId);
  if (idx <= 0) return null; // top of column
  return order[idx - 1].id;
}

/**
 * Returns the card element that should appear immediately *below* the cursor,
 * i.e. the insertion point, or null if dropping at the end.
 */
function getCardAfterPoint(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const midpoint = box.top + box.height / 2;
    if (y < midpoint) return card;
  }
  return null;
}

function clearIndicators() {
  document
    .querySelectorAll('.drop-indicator-before')
    .forEach((el) => el.classList.remove('drop-indicator-before'));
}

// ---------------------------------------------------------------------------
// Real-time sync via SSE
// ---------------------------------------------------------------------------

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('online'));
  source.addEventListener('error', () => setStatus('offline'));

  source.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
  });

  source.addEventListener('card-moved', (e) => {
    const { card, renormalized } = JSON.parse(e.data);
    if (renormalized) {
      store.applyRenormalized(renormalized);
    } else {
      store.upsertCard(card);
    }
  });

  return source;
}

function setStatus(state) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent =
    state === 'online' ? 'live' : state === 'offline' ? 'reconnecting…' : 'connecting…';
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

async function loadBoard() {
  const board = await fetchBoard();
  store.setBoard(board);
}

async function init() {
  store.onChange(render);
  setStatus('connecting');
  try {
    await loadBoard();
  } catch (err) {
    console.error('Failed to load board', err);
  }
  connectStream();
}

init();
