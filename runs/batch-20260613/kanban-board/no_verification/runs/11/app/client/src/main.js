import './style.css';
import { fetchBoard, createCard, moveCard } from './api.js';

/**
 * Client-side authoritative model.
 *
 * state.columns: ordered list of { id, title }
 * state.cards:   Map<cardId, { id, columnId, text, position, createdAt }>
 *
 * Rendering always derives column membership and ordering from this model,
 * which guarantees each card renders in exactly one column at one slot.
 */
const state = {
  columns: [],
  cards: new Map(),
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.columnId === columnId) list.push(card);
  }
  list.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    // Stable tiebreak so all clients converge on the same total order.
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  return list;
}

function upsertCard(card) {
  state.cards.set(card.id, {
    id: card.id,
    columnId: card.columnId,
    text: card.text,
    position: Number(card.position),
    createdAt: card.createdAt,
  });
}

/**
 * Apply a canonical column ordering broadcast by the server. Replaces the
 * positions/columnId of all cards in that column and removes any local cards
 * that the server says are no longer there.
 */
function applyCanonicalColumn(column) {
  const incomingIds = new Set(column.cards.map((c) => c.id));
  // Remove cards that the model currently places in this column but that the
  // server no longer lists here (e.g. moved away). The mover/creator will be
  // re-added via their own canonical column updates.
  for (const card of [...state.cards.values()]) {
    if (card.columnId === column.id && !incomingIds.has(card.id)) {
      state.cards.delete(card.id);
    }
  }
  for (const c of column.cards) {
    upsertCard(c);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve scroll positions of card lists across re-renders.
  const scrolls = new Map();
  boardEl.querySelectorAll('.card-list').forEach((el) => {
    scrolls.set(el.dataset.columnId, el.scrollTop);
  });

  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }

  boardEl.querySelectorAll('.card-list').forEach((el) => {
    if (scrolls.has(el.dataset.columnId)) {
      el.scrollTop = scrolls.get(el.dataset.columnId);
    }
  });
}

function renderColumn(col) {
  const cards = cardsForColumn(col.id);

  const columnEl = document.createElement('section');
  columnEl.className = 'column';
  columnEl.dataset.columnId = col.id;

  const header = document.createElement('div');
  header.className = 'column-header';
  const title = document.createElement('span');
  title.textContent = col.title;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(cards.length);
  header.append(title, count);

  const list = document.createElement('ul');
  list.className = 'card-list';
  list.dataset.columnId = col.id;
  for (const card of cards) {
    list.appendChild(renderCard(card));
  }
  attachListDnd(list, col.id);

  const adder = renderAdder(col.id);

  columnEl.append(header, list, adder);
  return columnEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.cardId = card.id;
  li.draggable = true;
  li.textContent = card.text;
  attachCardDnd(li, card.id);
  return li;
}

function renderAdder(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const toggle = document.createElement('button');
  toggle.className = 'add-toggle';
  toggle.textContent = '+ Add a card';

  const form = document.createElement('div');
  form.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card…';

  const row = document.createElement('div');
  row.className = 'row';
  const submit = document.createElement('button');
  submit.textContent = 'Add card';
  const cancel = document.createElement('button');
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  row.append(submit, cancel);

  form.append(textarea, row);
  wrap.append(toggle, form);

  function open() {
    form.style.display = 'block';
    toggle.style.display = 'none';
    textarea.focus();
  }
  function close() {
    form.style.display = 'none';
    toggle.style.display = 'block';
    textarea.value = '';
  }

  toggle.addEventListener('click', open);
  cancel.addEventListener('click', close);

  async function add() {
    const text = textarea.value.trim();
    if (!text) return;
    submit.disabled = true;
    try {
      // The created card will arrive via SSE; we also apply it here so the
      // creating client sees it immediately even if SSE is briefly delayed.
      const { card } = await createCard(columnId, text);
      upsertCard(card);
      render();
      close();
    } catch (err) {
      alert(`Could not add card: ${err.message}`);
    } finally {
      submit.disabled = false;
    }
  }

  submit.addEventListener('click', add);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      add();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return wrap;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

let dragState = null; // { cardId }

function clearDropMarkers() {
  boardEl
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  boardEl
    .querySelectorAll('.card-list.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

function attachCardDnd(li, cardId) {
  li.addEventListener('dragstart', (e) => {
    dragState = { cardId };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDropMarkers();
    dragState = null;
  });
}

function attachListDnd(list, columnId) {
  list.addEventListener('dragover', (e) => {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    clearDropMarkers();
    list.classList.add('drag-over');

    const target = getDropTarget(list, e.clientY);
    if (target.element) {
      target.element.classList.add(
        target.position === 'before' ? 'drop-before' : 'drop-after'
      );
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (e.target === list) list.classList.remove('drag-over');
  });

  list.addEventListener('drop', (e) => {
    if (!dragState) return;
    e.preventDefault();
    const cardId = dragState.cardId;
    const target = getDropTarget(list, e.clientY);
    clearDropMarkers();
    handleDrop(cardId, columnId, target);
  });
}

/**
 * Determine where in the list a drop would land, returning the neighboring
 * card element and whether the dragged card goes before or after it.
 */
function getDropTarget(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  if (cards.length === 0) {
    return { element: null, position: 'end' };
  }
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      return { element: el, position: 'before' };
    }
  }
  return { element: cards[cards.length - 1], position: 'after' };
}

/**
 * Translate a drop into { beforeId, afterId } intent and send it to the
 * server, after optimistically updating the local model.
 *
 * afterId  = the card directly ABOVE the dropped card
 * beforeId = the card directly BELOW the dropped card
 */
async function handleDrop(cardId, columnId, target) {
  const orderedNow = cardsForColumn(columnId).filter((c) => c.id !== cardId);

  let afterId = null;
  let beforeId = null;

  if (target.element) {
    const neighborId = target.element.dataset.cardId;
    const idx = orderedNow.findIndex((c) => c.id === neighborId);
    if (target.position === 'before') {
      beforeId = neighborId;
      afterId = idx > 0 ? orderedNow[idx - 1].id : null;
    } else {
      afterId = neighborId;
      beforeId = idx < orderedNow.length - 1 ? orderedNow[idx + 1].id : null;
    }
  } else {
    // Dropped into an empty area / end of column.
    afterId = orderedNow.length ? orderedNow[orderedNow.length - 1].id : null;
    beforeId = null;
  }

  // --- Optimistic update ---------------------------------------------------
  optimisticReorder(cardId, columnId, afterId, beforeId);
  render();

  // --- Reconcile against the server ---------------------------------------
  try {
    const result = await moveCard(cardId, { columnId, beforeId, afterId });
    // Apply canonical ordering of the affected column.
    applyCanonicalColumn(result.column);
    upsertCard(result.card);
    render();
  } catch (err) {
    // On failure, re-fetch the authoritative board to recover.
    // eslint-disable-next-line no-console
    console.error('Move failed, resyncing:', err);
    await loadBoard();
  }
}

/**
 * Optimistically place a card between afterId and beforeId in columnId by
 * assigning it an interpolated position. The server will later return the
 * canonical value.
 */
function optimisticReorder(cardId, columnId, afterId, beforeId) {
  const card = state.cards.get(cardId);
  if (!card) return;

  const siblings = cardsForColumn(columnId).filter((c) => c.id !== cardId);
  const afterCard = afterId ? state.cards.get(afterId) : null;
  const beforeCard = beforeId ? state.cards.get(beforeId) : null;

  let pos;
  const afterPos = afterCard ? afterCard.position : null;
  const beforePos = beforeCard ? beforeCard.position : null;

  if (afterPos == null && beforePos == null) {
    pos = siblings.length ? siblings[0].position - 1000 : 1000;
  } else if (afterPos == null) {
    pos = beforePos - 1000;
  } else if (beforePos == null) {
    pos = afterPos + 1000;
  } else {
    pos = (afterPos + beforePos) / 2;
  }

  card.columnId = columnId;
  card.position = pos;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function setStatus(kind, text) {
  statusEl.classList.remove('connected', 'disconnected');
  if (kind) statusEl.classList.add(kind);
  statusTextEl.textContent = text;
}

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('hello', () => setStatus('connected', 'live'));
  es.addEventListener('open', () => setStatus('connected', 'live'));
  es.onopen = () => setStatus('connected', 'live');

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card:move', (e) => {
    const { card, column } = JSON.parse(e.data);
    // Apply the canonical column ordering, then ensure the moved card is
    // present (it lives in `column`, but guard anyway).
    applyCanonicalColumn(column);
    upsertCard(card);
    render();
  });

  es.onerror = () => {
    setStatus('disconnected', 'reconnecting…');
    // EventSource auto-reconnects; on reconnect we re-sync the board to catch
    // any events missed while disconnected.
    if (es.readyState === EventSource.CONNECTING) {
      // Will retry automatically.
    }
  };

  // When the browser comes back online or the tab is refocused, re-sync to
  // guarantee convergence even if events were missed.
  window.addEventListener('online', loadBoard);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadBoard();
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadBoard() {
  const board = await fetchBoard();
  state.columns = board.columns.map((c) => ({ id: c.id, title: c.title }));
  state.cards.clear();
  for (const col of board.columns) {
    for (const card of col.cards) {
      upsertCard(card);
    }
  }
  render();
}

async function main() {
  setStatus(null, 'connecting…');
  try {
    await loadBoard();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to load board:', err);
    setStatus('disconnected', 'offline');
  }
  connectStream();
}

main();
