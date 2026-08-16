import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const store = new BoardStore();
const boardEl = document.getElementById('board');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// Track in-flight optimistic moves so an SSE echo of our own move doesn't
// fight the (already-applied) optimistic state mid-drag.
let dragState = null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve the open "add card" editor state across re-renders.
  const editingColumn = document.querySelector('.add-card.editing')?.dataset.columnId;
  const editingValue = document.querySelector('.add-card.editing textarea')?.value;

  boardEl.innerHTML = '';
  for (const col of store.columns) {
    boardEl.appendChild(renderColumn(col, editingColumn, editingValue));
  }
}

function renderColumn(col, editingColumn, editingValue) {
  const cards = store.cardsForColumn(col.id);

  const column = el('div', 'column');
  column.dataset.columnId = col.id;

  const header = el('div', 'column-header');
  header.append(text(col.title));
  const count = el('span', 'column-count', String(cards.length));
  header.append(count);
  column.append(header);

  const list = el('div', 'card-list');
  list.dataset.columnId = col.id;
  for (const card of cards) {
    list.append(renderCard(card));
  }
  setupDropTarget(list);
  column.append(list);

  column.append(renderAddCard(col, editingColumn, editingValue));
  return column;
}

function renderCard(card) {
  const node = el('div', 'card');
  node.dataset.cardId = card.id;
  node.draggable = true;
  node.textContent = card.text;

  node.addEventListener('dragstart', (e) => {
    dragState = { cardId: card.id, fromColumn: card.column_id };
    node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    clearIndicators();
    dragState = null;
  });
  return node;
}

function renderAddCard(col, editingColumn, editingValue) {
  const wrap = el('div', 'add-card');
  wrap.dataset.columnId = col.id;

  const btn = el('button', 'add-card-btn', '+ Add a card');
  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.placeholder = 'Enter card text…';

  const actions = el('div', 'add-card-actions');
  const save = el('button', 'btn-primary', 'Add');
  const cancel = el('button', 'btn-ghost', '✕');
  actions.append(save, cancel);

  wrap.append(btn, textarea, actions);

  const open = () => {
    wrap.classList.add('editing');
    textarea.focus();
  };
  const close = () => {
    wrap.classList.remove('editing');
    textarea.value = '';
  };
  const submit = async () => {
    const value = textarea.value.trim();
    if (!value) {
      close();
      return;
    }
    close();
    try {
      await createCard(col.id, value);
      // Server broadcasts card:create; our own SSE echo renders it.
    } catch (err) {
      console.error(err);
    }
  };

  btn.addEventListener('click', open);
  save.addEventListener('click', submit);
  cancel.addEventListener('click', close);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  if (editingColumn === col.id) {
    wrap.classList.add('editing');
    textarea.value = editingValue || '';
    setTimeout(() => textarea.focus(), 0);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

function setupDropTarget(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showIndicator(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear if leaving the list entirely.
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (!dragState) return;

    const cardId = dragState.cardId;
    const columnId = list.dataset.columnId;

    // Determine neighbors based on the drop indicator position.
    const { afterId, beforeId } = computeNeighbors(list, e.clientY, cardId);
    clearIndicators();

    // 1. Optimistic update: reposition in the model + re-render immediately.
    store.optimisticMove(cardId, columnId, beforeId, afterId);
    render();

    // 2. Send intent to the server; reconcile on response/echo.
    try {
      const { card, renormalized } = await moveCard(cardId, columnId, beforeId, afterId);
      store.upsertCard(card);
      store.applyRenormalized(renormalized);
      render();
    } catch (err) {
      console.error(err);
      // On failure, refetch authoritative state.
      await reload();
    }
  });
}

/**
 * Compute the after/before neighbor card ids for a drop at clientY within a
 * list, excluding the dragged card itself.
 */
function computeNeighbors(list, clientY, draggingId) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (c) => c.dataset.cardId !== draggingId
  );
  let beforeId = null; // card that ends up directly below the dropped card
  for (const c of cards) {
    const rect = c.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      beforeId = c.dataset.cardId;
      break;
    }
  }
  let afterId = null; // card directly above the dropped card
  if (beforeId == null) {
    afterId = cards.length ? cards[cards.length - 1].dataset.cardId : null;
  } else {
    const idx = cards.findIndex((c) => c.dataset.cardId === beforeId);
    afterId = idx > 0 ? cards[idx - 1].dataset.cardId : null;
  }
  return { afterId, beforeId };
}

function showIndicator(list, clientY) {
  clearIndicators();
  const draggingId = dragState?.cardId;
  const cards = [...list.querySelectorAll('.card')].filter(
    (c) => c.dataset.cardId !== draggingId
  );
  const indicator = el('div', 'drop-indicator');
  let inserted = false;
  for (const c of cards) {
    const rect = c.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      list.insertBefore(indicator, c);
      inserted = true;
      break;
    }
  }
  if (!inserted) list.appendChild(indicator);
}

function clearIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((n) => n.remove());
}

// ---------------------------------------------------------------------------
// SSE real-time sync
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => setStatus(true));
  es.addEventListener('open', () => setStatus(true));
  es.onopen = () => setStatus(true);

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
    render();
  });

  es.addEventListener('card:move', (e) => {
    const { card, renormalized } = JSON.parse(e.data);
    store.upsertCard(card);
    store.applyRenormalized(renormalized);
    render();
  });

  es.onerror = () => {
    setStatus(false);
    // EventSource auto-reconnects; status will flip back on reconnect.
  };
}

function setStatus(online) {
  statusDot.classList.toggle('online', online);
  statusDot.classList.toggle('offline', !online);
  statusText.textContent = online ? 'Live' : 'Reconnecting…';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = textContent;
  return node;
}
function text(t) {
  return document.createTextNode(t);
}

async function reload() {
  const data = await fetchBoard();
  store.load(data);
  render();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    await reload();
  } catch (err) {
    console.error('Failed to load board', err);
  }
  // Allow disabling SSE (e.g. for headless screenshot tooling that waits for
  // network idle). Real usage never sets this flag.
  if (new URLSearchParams(location.search).has('nosse')) {
    setStatus(true);
    return;
  }
  // Defer opening the long-lived SSE connection until the browser is idle so
  // initial load/paint completes first. EventSource auto-reconnects anyway.
  const start = () => connectStream();
  if ('requestIdleCallback' in window) {
    requestIdleCallback(start, { timeout: 1000 });
  } else {
    setTimeout(start, 200);
  }
})();
