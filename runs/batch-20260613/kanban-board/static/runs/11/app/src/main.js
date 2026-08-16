import './style.css';
import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const store = new BoardStore();
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// Tracks the card id currently being dragged (so dragover/drop can compute the
// intended neighbours).
let draggingId = null;

// -- Rendering --------------------------------------------------------------

function render() {
  // Preserve the "add card" composer state per column across re-renders.
  const openComposers = new Set(
    [...boardEl.querySelectorAll('.column__add[data-open="true"]')].map(
      (el) => el.closest('.column').dataset.columnId
    )
  );

  boardEl.innerHTML = '';
  for (const column of store.columns) {
    boardEl.appendChild(
      renderColumn(column, openComposers.has(column.id))
    );
  }
}

function renderColumn(column, composerOpen) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const cards = store.cardsForColumn(column.id);

  const header = document.createElement('div');
  header.className = 'column__header';
  header.innerHTML = `<span>${escapeHtml(column.title)}</span><span class="column__count">${cards.length}</span>`;
  colEl.appendChild(header);

  const cardsEl = document.createElement('div');
  cardsEl.className = 'column__cards';
  cardsEl.dataset.columnId = column.id;

  for (const card of cards) {
    cardsEl.appendChild(renderCard(card));
  }

  attachColumnDnd(cardsEl, column.id);
  colEl.appendChild(cardsEl);

  colEl.appendChild(renderComposer(column.id, composerOpen));

  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;

  el.addEventListener('dragstart', (e) => {
    draggingId = card.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  el.addEventListener('dragend', () => {
    draggingId = null;
    el.classList.remove('dragging');
    clearDropMarkers();
  });

  return el;
}

function renderComposer(columnId, open) {
  const wrap = document.createElement('div');
  wrap.className = 'column__add';
  wrap.dataset.open = open ? 'true' : 'false';

  const addBtn = document.createElement('button');
  addBtn.className = 'column__add-btn';
  addBtn.textContent = '+ Add a card';

  const form = document.createElement('div');
  form.className = 'composer-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card…';

  const actions = document.createElement('div');
  actions.className = 'add-actions';
  const save = document.createElement('button');
  save.className = 'save';
  save.textContent = 'Add card';
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  actions.append(save, cancel);
  form.append(textarea, actions);

  function setOpen(isOpen) {
    wrap.dataset.open = isOpen ? 'true' : 'false';
    addBtn.classList.toggle('hidden', isOpen);
    form.classList.toggle('hidden', !isOpen);
    if (isOpen) textarea.focus();
  }

  async function submit() {
    const text = textarea.value.trim();
    if (!text) {
      setOpen(false);
      return;
    }
    textarea.value = '';
    try {
      // The card will arrive (and render) via the SSE broadcast.
      await createCard(columnId, text);
    } catch (err) {
      console.error('Failed to create card', err);
    }
    // Keep composer open for rapid entry.
    textarea.focus();
  }

  addBtn.addEventListener('click', () => setOpen(true));
  cancel.addEventListener('click', () => {
    textarea.value = '';
    setOpen(false);
  });
  save.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  });

  wrap.append(addBtn, form);
  setOpen(open);
  return wrap;
}

// -- Drag & drop ------------------------------------------------------------

function attachColumnDnd(cardsEl, columnId) {
  cardsEl.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cardsEl.classList.add('drag-over');
    showDropMarker(cardsEl, e.clientY);
  });

  cardsEl.addEventListener('dragleave', (e) => {
    // Only clear when leaving the cards container entirely.
    if (!cardsEl.contains(e.relatedTarget)) {
      cardsEl.classList.remove('drag-over');
    }
  });

  cardsEl.addEventListener('drop', (e) => {
    if (!draggingId) return;
    e.preventDefault();
    cardsEl.classList.remove('drag-over');
    const cardId = draggingId;
    const { afterId, beforeId } = computeNeighbours(cardsEl, e.clientY, cardId);
    clearDropMarkers();
    performMove(cardId, columnId, afterId, beforeId);
  });
}

/**
 * Determine, given the pointer Y position, which card the dragged card should
 * be inserted *after* and *before* (by id), excluding the dragged card itself.
 */
function computeNeighbours(cardsEl, clientY, draggedCardId) {
  const cardEls = [...cardsEl.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggedCardId
  );

  let afterId = null; // card above the insertion point
  let beforeId = null; // card below the insertion point

  for (const el of cardEls) {
    const rect = el.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      beforeId = el.dataset.cardId;
      break;
    }
    afterId = el.dataset.cardId;
  }

  return { afterId, beforeId };
}

function showDropMarker(cardsEl, clientY) {
  clearDropMarkers();
  const cardEls = [...cardsEl.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggingId
  );
  if (cardEls.length === 0) return;

  for (const el of cardEls) {
    const rect = el.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      el.classList.add('drop-before');
      return;
    }
  }
  cardEls[cardEls.length - 1].classList.add('drop-after');
}

function clearDropMarkers() {
  for (const el of boardEl.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

/**
 * Optimistically move the card locally, then send the intent to the server.
 * The authoritative position comes back via the move response (and SSE), at
 * which point we reconcile.
 */
async function performMove(cardId, columnId, afterId, beforeId) {
  const card = store.getCard(cardId);
  if (!card) return;

  // --- Optimistic update -------------------------------------------------
  // Compute a tentative position locally so the card snaps into place
  // immediately, before the server responds.
  const optimisticPosition = optimisticPositionFor(columnId, afterId, beforeId);
  store.upsertCard({
    ...card,
    columnId,
    position: optimisticPosition,
  });
  render();

  // --- Send intent & reconcile ------------------------------------------
  try {
    const result = await moveCard(cardId, {
      columnId,
      afterId: afterId ?? null,
      beforeId: beforeId ?? null,
    });
    // Apply canonical server state. If our optimistic guess differed, this
    // snaps the card (and any renormalized siblings) to the server order.
    store.applyColumn(result.column);
    store.upsertCard(result.card);
    render();
  } catch (err) {
    console.error('Move failed, refetching board', err);
    await loadBoard();
  }
}

function optimisticPositionFor(columnId, afterId, beforeId) {
  const after = afterId ? store.getCard(afterId) : null;
  const before = beforeId ? store.getCard(beforeId) : null;
  const afterPos = after ? after.position : null;
  const beforePos = before ? before.position : null;

  if (afterPos == null && beforePos == null) {
    // Empty column or only the dragged card.
    return 1024;
  }
  if (afterPos == null) return beforePos / 2;
  if (beforePos == null) return afterPos + 1024;
  return (afterPos + beforePos) / 2;
}

// -- Realtime (SSE) ---------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('hello', () => setStatus('connected'));
  es.addEventListener('open', () => setStatus('connected'));
  es.onopen = () => setStatus('connected');

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
    render();
  });

  es.addEventListener('card:moved', (e) => {
    const { card, column } = JSON.parse(e.data);
    // Apply the full canonical column ordering, then ensure the moved card's
    // columnId is authoritative (it may have left another column).
    if (column) store.applyColumn(column);
    if (card) store.upsertCard(card);
    render();
  });

  es.onerror = () => {
    setStatus('disconnected');
    // EventSource auto-reconnects; status will flip back on reconnect.
  };
}

// -- Bootstrap --------------------------------------------------------------

function setStatus(state) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent =
    state === 'connected'
      ? 'live'
      : state === 'disconnected'
        ? 'reconnecting…'
        : 'connecting…';
}

async function loadBoard() {
  const board = await fetchBoard();
  store.setBoard(board);
  render();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function init() {
  try {
    await loadBoard();
  } catch (err) {
    console.error('Failed to load board', err);
  }
  connectStream();
}

init();
