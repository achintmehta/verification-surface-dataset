import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const boardEl = document.getElementById('board');
const connEl = document.getElementById('connection');
const store = new BoardStore();

// Tracks the card currently being dragged (id) so dragover/drop can compute the
// intended insert position.
let dragCardId = null;

// ---------------------------------------------------------------------------
// Rendering: the DOM is a pure projection of `store`. Re-rendering after any
// mutation guarantees a card never appears in two places, because each card
// exists in exactly one column array in the store.
// ---------------------------------------------------------------------------

function render() {
  boardEl.innerHTML = '';
  for (const col of store.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const title = document.createElement('div');
  title.className = 'column__title';
  title.textContent = col.title;
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'column__cards';
  list.dataset.columnId = col.id;

  for (const card of col.cards) {
    list.appendChild(renderCard(card));
  }

  // Drag target handlers on the list.
  list.addEventListener('dragover', onDragOver);
  list.addEventListener('dragleave', onDragLeave);
  list.addEventListener('drop', onDrop);

  colEl.appendChild(list);
  colEl.appendChild(renderAddCard(col.id));
  return colEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;

  li.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });
  li.addEventListener('dragend', () => {
    dragCardId = null;
    li.classList.remove('dragging');
    clearPlaceholders();
  });

  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Add a card…';
  textarea.rows = 1;

  const button = document.createElement('button');
  button.textContent = 'Add card';

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      // The created card will arrive via SSE; we add it on the server response
      // too so the author sees it immediately even without SSE latency.
      const { card } = await createCard(columnId, text);
      applyCreate(card);
    } catch (err) {
      console.error('create failed', err);
      alert('Failed to add card: ' + err.message);
    }
  };

  button.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  wrap.appendChild(textarea);
  wrap.appendChild(button);
  return wrap;
}

// ---------------------------------------------------------------------------
// Drag-and-drop position calculation
// ---------------------------------------------------------------------------

function clearPlaceholders() {
  document.querySelectorAll('.card--placeholder').forEach((el) => el.remove());
  document.querySelectorAll('.column__cards.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}

/**
 * Returns the card element AFTER which a drop at clientY should land within the
 * given list (i.e., the element directly above the cursor). Excludes the card
 * being dragged and placeholders.
 */
function getDropAfterElement(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let afterEl = null;
  let beforeEl = null;
  for (const el of cards) {
    const box = el.getBoundingClientRect();
    const mid = box.top + box.height / 2;
    if (clientY >= mid) {
      afterEl = el; // cursor is below this card's midpoint
    } else if (beforeEl == null) {
      beforeEl = el; // first card whose midpoint is below cursor
    }
  }
  return { afterEl, beforeEl };
}

function onDragOver(e) {
  if (!dragCardId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const list = e.currentTarget;
  list.classList.add('drag-over');
}

function onDragLeave(e) {
  const list = e.currentTarget;
  // Only clear when truly leaving the list (not entering a child).
  if (!list.contains(e.relatedTarget)) {
    list.classList.remove('drag-over');
  }
}

async function onDrop(e) {
  e.preventDefault();
  const list = e.currentTarget;
  list.classList.remove('drag-over');
  const cardId = dragCardId || e.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const columnId = list.dataset.columnId;
  const { afterEl, beforeEl } = getDropAfterElement(list, e.clientY);
  const afterId = afterEl ? afterEl.dataset.cardId : null;
  const beforeId = beforeEl ? beforeEl.dataset.cardId : null;

  // 1) Optimistic local update: place the card immediately in the store/DOM.
  store.upsertAt(store.cardIndex.get(cardId), columnId, beforeId);
  render();

  // 2) Send intent to server; reconcile against the canonical response.
  try {
    const result = await moveCard(cardId, { columnId, beforeId, afterId });
    applyMove(result.card, result.columns);
  } catch (err) {
    console.error('move failed', err);
    // On failure, re-sync from the server to recover a consistent state.
    await reload();
  }
}

// ---------------------------------------------------------------------------
// Applying canonical state (from server responses and SSE)
// ---------------------------------------------------------------------------

function applyCreate(card) {
  if (!card) return;
  // Insert at end of its column unless already present.
  store.upsertAt(card, card.column_id, null);
  render();
}

function applyMove(card, columns) {
  if (card) {
    // Ensure the card is attached to its canonical column first.
    store.upsertAt(card, card.column_id, null);
  }
  // Apply canonical ordering for every column the server reported. This snaps
  // optimistic guesses to the authoritative total order and resolves any
  // renormalization.
  if (columns) {
    for (const [columnId, ordered] of Object.entries(columns)) {
      store.setColumnOrder(columnId, ordered);
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// SSE realtime sync
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    applyCreate(card);
  });

  es.addEventListener('card:move', (e) => {
    const { card, columns } = JSON.parse(e.data);
    applyMove(card, columns);
  });

  return es;
}

function setConn(on) {
  connEl.textContent = on ? 'live' : 'offline';
  connEl.className = 'conn ' + (on ? 'conn--on' : 'conn--off');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function reload() {
  const board = await fetchBoard();
  store.loadBoard(board);
  render();
}

async function init() {
  try {
    await reload();
  } catch (err) {
    console.error('failed to load board', err);
    boardEl.textContent = 'Failed to load board.';
    return;
  }
  connectStream();
}

init();
